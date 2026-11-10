/**
 * External-agent relay (ADR 0028) — the WebSocket a person's daemon (`codea connect`) holds open so
 * the agent it serves can be asked to take a turn.
 *
 * The shape is `lib/mcp-relay.ts`, run the other way round: there a client lends Alia TOOLS and the
 * server calls them; here a client lends Alia an AGENT and the server hands it TURNS. A turn is one
 * `turn` frame down and `delta`* + `end` (or `error`) frames back.
 *
 * ## More than one instance
 *
 * The socket lives in the process that accepted it, but a turn can start on any instance. With Redis
 * (`cluster.ts`) the instance holding the socket announces the agent and answers commands published
 * for it; an instance without the socket publishes the turn and relays the events back. Without
 * Redis only the local socket can answer, which is right for one instance.
 */

import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { getDb } from '../../db/index.js';
import {
  findExternalLink,
  markExternalLinkConnected,
} from '../../db/agents/externalAgentRepository.js';
import {
  EXTERNAL_TURN_TIMEOUT_MS,
  type DaemonFrame,
  type ServerFrame,
} from '../../domain/external-agent.js';
import { log } from '../logger.js';
import { authenticateSocketToken } from '../socket-session-auth.js';
import type { WebSocketRoute } from '../websocket-upgrades.js';
import { CMD_PREFIX, EVT_PREFIX, getClusterBus, type ClusterBus } from './cluster.js';

export const EXTERNAL_AGENT_RELAY_PATH = '/ws/external-agent';

const AUTH_TIMEOUT_MS = 5_000;
/** Same cadence as the MCP relay: the ALB (60 s) and Cloudflare (100 s) cut a silent connection. */
const HEARTBEAT_INTERVAL_MS = 25_000;
/** How long an instance waits for the one that holds the socket to take a turn it published. */
const REMOTE_ACK_TIMEOUT_MS = 4_000;

type ChatTurn = { role: 'user' | 'assistant'; content: string };

export interface ExternalTurnInput {
  agentId: string;
  task: string;
  history: readonly ChatTurn[];
  onDelta?: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The agent has no daemon connected, or the daemon went away mid-turn. */
export class ExternalAgentOfflineError extends Error {
  constructor(message = 'The external agent is not connected') {
    super(message);
    this.name = 'ExternalAgentOfflineError';
  }
}

interface Connection {
  readonly ws: WebSocket;
  readonly ownerOxyUserId: string;
}

interface PendingTurn {
  readonly agentId: string;
  readonly onDelta?: (text: string) => void;
  readonly resolve: (result: { response: string }) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  text: string;
}

/** What the instance holding the socket tells the one that asked. */
type TurnEvent =
  | { type: 'ack' }
  | { type: 'delta'; text: string }
  | { type: 'end'; text: string }
  | { type: 'error'; message: string; offline?: boolean };

type Command =
  | { kind: 'turn'; turnId: string; task: string; history: ChatTurn[]; timeoutMs?: number }
  | { kind: 'cancel'; turnId: string }
  /** The link was revoked on another instance: drop the socket held here. */
  | { kind: 'revoke' };

export interface ExternalAgentRelay {
  readonly route: WebSocketRoute;
  /** Runs one turn on whichever instance holds the agent's socket. */
  runTurn(input: ExternalTurnInput): Promise<{ response: string }>;
  /** True when the agent's daemon is connected to THIS instance. */
  isLocallyOnline(agentId: string): boolean;
  /** True when it is connected to any instance. */
  isReachable(agentId: string): Promise<boolean>;
  disconnect(agentId: string): void;
  shutdown(): void;
}

function parseFrame(data: WebSocket.RawData): DaemonFrame | null {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    if (parsed === null || typeof parsed !== 'object') return null;
    const type = (parsed as { type?: unknown }).type;
    return typeof type === 'string' ? (parsed as DaemonFrame) : null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

export function createExternalAgentRelay(
  options: {
    observe?: (socket: WebSocket, headers: http.IncomingHttpHeaders) => void;
    heartbeatIntervalMs?: number;
    authTimeoutMs?: number;
    remoteAckTimeoutMs?: number;
    /** `null` for one instance; defaults to the process's Redis bus. */
    bus?: ClusterBus | null;
  } = {},
): ExternalAgentRelay {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  const remoteAckTimeoutMs = options.remoteAckTimeoutMs ?? REMOTE_ACK_TIMEOUT_MS;
  const bus = options.bus === undefined ? getClusterBus() : options.bus;

  const server = new WebSocketServer({ noServer: true });
  const connections = new Map<string, Connection>();
  const pendingTurns = new Map<string, PendingTurn>();
  /** Turns a REMOTE instance asked this one to run, so a `cancel` can reach them. */
  const remoteTurns = new Map<string, AbortController>();
  let stopCommands: (() => void) | null = null;
  let stopped = false;

  const publishEvent = (turnId: string, event: TurnEvent): void => {
    if (!bus) return;
    bus.publish(`${EVT_PREFIX}${turnId}`, JSON.stringify(event)).catch((err: unknown) => {
      log.general.warn({ err, turnId }, 'Could not publish an external agent event');
    });
  };

  const announce = (agentId: string): void => {
    bus?.setPresence(agentId).catch((err: unknown) => {
      log.general.warn({ err, agentId }, 'Could not announce an external agent');
    });
  };

  // ---- local turns -------------------------------------------------------------------------

  const settle = (turnId: string, pending: PendingTurn): void => {
    clearTimeout(pending.timer);
    pendingTurns.delete(turnId);
  };

  const failTurnsOf = (agentId: string, error: Error): void => {
    for (const [turnId, pending] of pendingTurns) {
      if (pending.agentId !== agentId) continue;
      settle(turnId, pending);
      pending.reject(error);
    }
  };

  const ownedPending = (agentId: string, turnId: unknown): PendingTurn | undefined => {
    if (typeof turnId !== 'string') return undefined;
    const pending = pendingTurns.get(turnId);
    return pending?.agentId === agentId ? pending : undefined;
  };

  const runLocalTurn = (input: ExternalTurnInput): Promise<{ response: string }> =>
    new Promise((resolve, reject) => {
      const connection = connections.get(input.agentId);
      if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
        reject(new ExternalAgentOfflineError());
        return;
      }
      if (input.signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const turnId = randomUUID();
      const timeoutMs = input.timeoutMs ?? EXTERNAL_TURN_TIMEOUT_MS;
      const timer = setTimeout(() => {
        const pending = pendingTurns.get(turnId);
        if (!pending) return;
        settle(turnId, pending);
        send(connection.ws, { type: 'cancel', turnId });
        pending.reject(new Error(`The external agent did not answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);

      pendingTurns.set(turnId, {
        agentId: input.agentId,
        ...(input.onDelta ? { onDelta: input.onDelta } : {}),
        resolve,
        reject,
        timer,
        text: '',
      });

      input.signal?.addEventListener(
        'abort',
        () => {
          const live = pendingTurns.get(turnId);
          if (!live) return;
          settle(turnId, live);
          send(connection.ws, { type: 'cancel', turnId });
          live.reject(new Error('Aborted'));
        },
        { once: true },
      );

      send(connection.ws, {
        type: 'turn',
        turnId,
        task: input.task,
        history: input.history,
      });
    });

  const disconnectLocal = (agentId: string): void => {
    const connection = connections.get(agentId);
    if (!connection) return;
    send(connection.ws, { type: 'revoked' });
    connection.ws.close(4004, 'Revoked');
    connections.delete(agentId);
    bus?.clearPresence(agentId).catch(() => undefined);
    failTurnsOf(agentId, new ExternalAgentOfflineError('The external agent was disconnected'));
  };

  // ---- turns another instance asked for ---------------------------------------------------------

  const onCommand = (channel: string, payload: string): void => {
    const agentId = channel.slice(CMD_PREFIX.length);
    const connection = connections.get(agentId);
    // Not ours: the instance that holds the socket answers.
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return;
    let command: Command;
    try {
      command = JSON.parse(payload) as Command;
    } catch {
      return;
    }
    if (command.kind === 'revoke') {
      disconnectLocal(agentId);
      return;
    }
    if (command.kind === 'cancel') {
      remoteTurns.get(command.turnId)?.abort();
      return;
    }
    if (command.kind !== 'turn' || typeof command.turnId !== 'string') return;

    const controller = new AbortController();
    remoteTurns.set(command.turnId, controller);
    publishEvent(command.turnId, { type: 'ack' });
    runLocalTurn({
      agentId,
      task: command.task,
      history: command.history,
      signal: controller.signal,
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      onDelta: (text) => publishEvent(command.turnId, { type: 'delta', text }),
    })
      .then(({ response }) => publishEvent(command.turnId, { type: 'end', text: response }))
      .catch((err: unknown) =>
        publishEvent(command.turnId, {
          type: 'error',
          message: err instanceof Error ? err.message : 'The external agent failed',
          ...(err instanceof ExternalAgentOfflineError ? { offline: true } : {}),
        }),
      )
      .finally(() => remoteTurns.delete(command.turnId));
  };

  if (bus) {
    bus
      .subscribePrefix(CMD_PREFIX, onCommand)
      .then((stop) => {
        if (stopped) stop();
        else stopCommands = stop;
      })
      .catch((err: unknown) => {
        log.general.error(
          { err },
          'External agents could not listen for turns from other instances',
        );
      });
  }

  const runRemoteTurn = async (
    cluster: ClusterBus,
    input: ExternalTurnInput,
  ): Promise<{ response: string }> => {
    if (!(await cluster.hasPresence(input.agentId))) throw new ExternalAgentOfflineError();
    if (input.signal?.aborted) throw new Error('Aborted');

    const turnId = randomUUID();
    const timeoutMs = input.timeoutMs ?? EXTERNAL_TURN_TIMEOUT_MS;

    return new Promise<{ response: string }>((resolve, reject) => {
      let text = '';
      let done = false;
      let unsubscribe: (() => void) | undefined;
      const cmdChannel = `${CMD_PREFIX}${input.agentId}`;

      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(ackTimer);
        clearTimeout(turnTimer);
        unsubscribe?.();
        fn();
      };
      const cancel = (): void => {
        cluster
          .publish(cmdChannel, JSON.stringify({ kind: 'cancel', turnId } satisfies Command))
          .catch(() => undefined);
      };

      // Nobody took the turn: the presence key outlived its holder.
      const ackTimer = setTimeout(
        () => finish(() => reject(new ExternalAgentOfflineError())),
        remoteAckTimeoutMs,
      );
      // The holder enforces `timeoutMs` itself; this only guards against a holder that vanished.
      const turnTimer = setTimeout(() => {
        cancel();
        finish(() =>
          reject(new Error(`The external agent did not answer within ${timeoutMs / 1000}s`)),
        );
      }, timeoutMs + remoteAckTimeoutMs);

      input.signal?.addEventListener(
        'abort',
        () => {
          cancel();
          finish(() => reject(new Error('Aborted')));
        },
        { once: true },
      );

      cluster
        .subscribe(`${EVT_PREFIX}${turnId}`, (payload) => {
          let event: TurnEvent;
          try {
            event = JSON.parse(payload) as TurnEvent;
          } catch {
            return;
          }
          if (event.type === 'ack') {
            clearTimeout(ackTimer);
          } else if (event.type === 'delta') {
            text += event.text;
            input.onDelta?.(event.text);
          } else if (event.type === 'end') {
            if (event.text.startsWith(text) && event.text.length > text.length) {
              input.onDelta?.(event.text.slice(text.length));
            }
            finish(() => resolve({ response: event.text }));
          } else if (event.type === 'error') {
            finish(() =>
              reject(
                event.offline
                  ? new ExternalAgentOfflineError(event.message)
                  : new Error(event.message),
              ),
            );
          }
        })
        .then((stop) => {
          if (done) {
            stop();
            return;
          }
          unsubscribe = stop;
          const command: Command = {
            kind: 'turn',
            turnId,
            task: input.task,
            history: [...input.history],
            timeoutMs,
          };
          return cluster.publish(cmdChannel, JSON.stringify(command));
        })
        .catch((err: unknown) => {
          log.general.warn(
            { err, agentId: input.agentId },
            'Could not hand a turn to another instance',
          );
          finish(() => reject(new ExternalAgentOfflineError()));
        });
    });
  };

  // ---- the WebSocket --------------------------------------------------------------------------

  const authenticate = async (
    ws: WebSocket,
    frame: Extract<DaemonFrame, { type: 'auth' }>,
  ): Promise<string | null> => {
    const refuse = (reason: string): null => {
      send(ws, { type: 'auth-error', reason });
      ws.close(4003, 'Forbidden');
      return null;
    };
    try {
      if (typeof frame.agentId !== 'string' || frame.agentId === '')
        return refuse('agent_required');
      const userId = await authenticateSocketToken(frame.token);
      if (!userId) return refuse('invalid_token');

      // The session's account must own a LIVE link to this agent: a token alone never names an agent.
      const link = await findExternalLink(getDb(), frame.agentId);
      if (link === undefined || link.ownerOxyUserId !== userId) return refuse('unknown_agent');

      const existing = connections.get(frame.agentId);
      if (existing && existing.ws.readyState === WebSocket.OPEN) {
        existing.ws.close(4000, 'Replaced by new connection');
      }
      connections.set(frame.agentId, { ws, ownerOxyUserId: userId });
      announce(frame.agentId);
      send(ws, { type: 'auth-ok', agentId: frame.agentId });
      void markExternalLinkConnected(getDb(), frame.agentId).catch((err: unknown) =>
        log.general.warn({ err }, 'Could not stamp external agent connection'),
      );
      log.general.info({ agentId: frame.agentId }, 'External agent connected');
      return frame.agentId;
    } catch (err: unknown) {
      log.general.error({ err }, 'External agent authentication failed');
      return refuse('server_error');
    }
  };

  const handleDaemonFrame = (agentId: string, ws: WebSocket, frame: DaemonFrame): void => {
    if (connections.get(agentId)?.ws !== ws) return;
    switch (frame.type) {
      case 'delta': {
        const pending = ownedPending(agentId, frame.turnId);
        if (!pending || typeof frame.text !== 'string' || frame.text === '') return;
        pending.text += frame.text;
        pending.onDelta?.(frame.text);
        break;
      }
      case 'end': {
        const pending = ownedPending(agentId, frame.turnId);
        if (!pending) return;
        settle(frame.turnId, pending);
        const response = typeof frame.text === 'string' ? frame.text : pending.text;
        if (response !== pending.text && response.startsWith(pending.text)) {
          // The daemon sent the final text without streaming the tail: surface the tail as a delta.
          pending.onDelta?.(response.slice(pending.text.length));
        }
        pending.resolve({ response });
        break;
      }
      case 'error': {
        const pending = ownedPending(agentId, frame.turnId);
        if (!pending) return;
        settle(frame.turnId, pending);
        pending.reject(
          new Error(typeof frame.message === 'string' ? frame.message : 'Agent failed'),
        );
        break;
      }
      default:
        break;
    }
  };

  server.on('connection', (ws, request) => {
    options.observe?.(ws, request.headers);
    let agentId: string | null = null;
    let authenticating = false;

    const authTimer = setTimeout(() => {
      if (!agentId) ws.close(4001, 'Auth timeout');
    }, authTimeoutMs);

    let answeredPing = true;
    ws.on('pong', () => {
      answeredPing = true;
    });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!answeredPing) {
        ws.terminate();
        return;
      }
      answeredPing = false;
      ws.ping();
      // The presence key outlives a few missed beats, so a crashed instance stops claiming the agent.
      if (agentId !== null && connections.get(agentId)?.ws === ws) announce(agentId);
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

    ws.on('message', (data) => {
      const frame = parseFrame(data);
      if (frame === null) return;

      if (agentId === null) {
        if (frame.type !== 'auth' || authenticating) return;
        authenticating = true;
        clearTimeout(authTimer);
        void authenticate(ws, frame).then((authenticated) => {
          authenticating = false;
          if (authenticated !== null) agentId = authenticated;
        });
        return;
      }

      handleDaemonFrame(agentId, ws, frame);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (agentId === null) return;
      // A reconnect replaces this socket's entry; only drop (and fail turns of) our own.
      if (connections.get(agentId)?.ws === ws) {
        connections.delete(agentId);
        bus?.clearPresence(agentId).catch(() => undefined);
        failTurnsOf(agentId, new ExternalAgentOfflineError('The external agent disconnected'));
        log.general.info({ agentId }, 'External agent disconnected');
      }
    });

    ws.on('error', (err) => {
      log.general.warn({ err }, 'External agent WebSocket error');
    });
  });

  log.general.info(`External agent relay initialized at ${EXTERNAL_AGENT_RELAY_PATH}`);

  return {
    route: {
      path: EXTERNAL_AGENT_RELAY_PATH,
      handleUpgrade: (request, socket, head) => {
        server.handleUpgrade(request, socket, head, (ws) => {
          server.emit('connection', ws, request);
        });
      },
    },

    runTurn(input) {
      const local = connections.get(input.agentId);
      if (local && local.ws.readyState === WebSocket.OPEN) return runLocalTurn(input);
      if (bus) return runRemoteTurn(bus, input);
      return Promise.reject(new ExternalAgentOfflineError());
    },

    isLocallyOnline: (agentId) => connections.get(agentId)?.ws.readyState === WebSocket.OPEN,

    async isReachable(agentId) {
      if (connections.get(agentId)?.ws.readyState === WebSocket.OPEN) return true;
      if (!bus) return false;
      try {
        return await bus.hasPresence(agentId);
      } catch {
        return false;
      }
    },

    disconnect(agentId) {
      if (connections.has(agentId)) {
        disconnectLocal(agentId);
        return;
      }
      // The socket may be held by another instance: ask it to drop it.
      bus
        ?.publish(`${CMD_PREFIX}${agentId}`, JSON.stringify({ kind: 'revoke' } satisfies Command))
        .catch(() => undefined);
    },

    shutdown() {
      stopped = true;
      stopCommands?.();
      for (const [agentId, connection] of connections) {
        connection.ws.close(1001, 'Server shutting down');
        bus?.clearPresence(agentId).catch(() => undefined);
      }
      connections.clear();
      for (const controller of remoteTurns.values()) controller.abort();
      for (const [turnId, pending] of pendingTurns) {
        settle(turnId, pending);
        pending.reject(new Error('Server shutting down'));
      }
      server.close();
    },
  };
}

// ---- the process's relay ---------------------------------------------------------------------------

let current: ExternalAgentRelay | null = null;

export function externalAgentRelayRoute(
  observe?: (socket: WebSocket, headers: http.IncomingHttpHeaders) => void,
  options: { heartbeatIntervalMs?: number; authTimeoutMs?: number; bus?: ClusterBus | null } = {},
): WebSocketRoute {
  current?.shutdown();
  current = createExternalAgentRelay({ ...options, ...(observe ? { observe } : {}) });
  return current.route;
}

export function isExternalAgentOnline(agentId: string): boolean {
  return current?.isLocallyOnline(agentId) ?? false;
}

/** Connected to any instance (this one, or another through Redis). */
export async function isExternalAgentReachable(agentId: string): Promise<boolean> {
  return (await current?.isReachable(agentId)) ?? false;
}

/** Hands one turn to the agent's daemon, wherever it is connected, and resolves with the full answer. */
export function runExternalTurn(input: ExternalTurnInput): Promise<{ response: string }> {
  return current ? current.runTurn(input) : Promise.reject(new ExternalAgentOfflineError());
}

/** Cuts the agent's daemon off (revocation). */
export function disconnectExternalAgent(agentId: string): void {
  current?.disconnect(agentId);
}

export function shutdownExternalAgentRelay(): void {
  current?.shutdown();
  current = null;
}
