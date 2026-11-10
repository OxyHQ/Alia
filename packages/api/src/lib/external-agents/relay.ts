/**
 * External-agent relay (ADR 0028) — the WebSocket a person's daemon (`codea connect`) holds open so
 * the agent it serves can be asked to take a turn.
 *
 * The shape is `lib/mcp-relay.ts`, run the other way round: there a client lends Alia TOOLS and the
 * server calls them; here a client lends Alia an AGENT and the server hands it TURNS. A turn is one
 * `turn` frame down and `delta`* + `end` (or `error`) frames back.
 *
 * ## One instance
 *
 * Like the MCP relay, the connection lives in this process, so a turn is only deliverable on the
 * instance the daemon dialled. A turn started elsewhere answers "offline" rather than hanging; the
 * ADR names cross-instance routing as the follow-up.
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

export const EXTERNAL_AGENT_RELAY_PATH = '/ws/external-agent';

const AUTH_TIMEOUT_MS = 5_000;
/** Same cadence as the MCP relay: the ALB (60 s) and Cloudflare (100 s) cut a silent connection. */
const HEARTBEAT_INTERVAL_MS = 25_000;

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

/** The agent has no daemon connected to this instance, or the daemon went away mid-turn. */
export class ExternalAgentOfflineError extends Error {
  constructor(message = 'The external agent is not connected') {
    super(message);
    this.name = 'ExternalAgentOfflineError';
  }
}

let wss: WebSocketServer | null = null;
const connections = new Map<string, Connection>();
const pendingTurns = new Map<string, PendingTurn>();

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
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

export function externalAgentRelayRoute(
  observe?: (socket: WebSocket, headers: http.IncomingHttpHeaders) => void,
  options: { heartbeatIntervalMs?: number; authTimeoutMs?: number } = {},
): WebSocketRoute {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  const server = new WebSocketServer({ noServer: true });
  wss = server;

  server.on('connection', (ws, request) => {
    observe?.(ws, request.headers);
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
    path: EXTERNAL_AGENT_RELAY_PATH,
    handleUpgrade: (request, socket, head) => {
      server.handleUpgrade(request, socket, head, (ws) => {
        server.emit('connection', ws, request);
      });
    },
  };
}

/** Returns the agent id on success, `null` after closing the socket. */
async function authenticate(
  ws: WebSocket,
  frame: Extract<DaemonFrame, { type: 'auth' }>,
): Promise<string | null> {
  const refuse = (reason: string): null => {
    send(ws, { type: 'auth-error', reason });
    ws.close(4003, 'Forbidden');
    return null;
  };
  try {
    if (typeof frame.agentId !== 'string' || frame.agentId === '') return refuse('agent_required');
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
}

function handleDaemonFrame(agentId: string, ws: WebSocket, frame: DaemonFrame): void {
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
      pending.reject(new Error(typeof frame.message === 'string' ? frame.message : 'Agent failed'));
      break;
    }
    default:
      break;
  }
}

/** Only the socket of the agent a turn was sent to may answer it. */
function ownedPending(agentId: string, turnId: unknown): PendingTurn | undefined {
  if (typeof turnId !== 'string') return undefined;
  const pending = pendingTurns.get(turnId);
  return pending?.agentId === agentId ? pending : undefined;
}

function settle(turnId: string, pending: PendingTurn): void {
  clearTimeout(pending.timer);
  pendingTurns.delete(turnId);
}

function failTurnsOf(agentId: string, error: Error): void {
  for (const [turnId, pending] of pendingTurns) {
    if (pending.agentId !== agentId) continue;
    settle(turnId, pending);
    pending.reject(error);
  }
}

export function isExternalAgentOnline(agentId: string): boolean {
  return connections.get(agentId)?.ws.readyState === WebSocket.OPEN;
}

/** Hands one turn to the agent's daemon and resolves with the full answer. */
export function runExternalTurn(input: {
  agentId: string;
  task: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  onDelta?: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ response: string }> {
  return new Promise((resolve, reject) => {
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

    const pending: PendingTurn = {
      agentId: input.agentId,
      ...(input.onDelta ? { onDelta: input.onDelta } : {}),
      resolve,
      reject,
      timer,
      text: '',
    };
    pendingTurns.set(turnId, pending);

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

    send(connection.ws, { type: 'turn', turnId, task: input.task, history: input.history });
  });
}

/** Cuts the agent's daemon off (revocation). */
export function disconnectExternalAgent(agentId: string): void {
  const connection = connections.get(agentId);
  if (!connection) return;
  send(connection.ws, { type: 'revoked' });
  connection.ws.close(4004, 'Revoked');
  connections.delete(agentId);
  failTurnsOf(agentId, new ExternalAgentOfflineError('The external agent was disconnected'));
}

export function shutdownExternalAgentRelay(): void {
  for (const connection of connections.values()) connection.ws.close(1001, 'Server shutting down');
  connections.clear();
  for (const [turnId, pending] of pendingTurns) {
    settle(turnId, pending);
    pending.reject(new Error('Server shutting down'));
  }
  wss?.close();
  wss = null;
}
