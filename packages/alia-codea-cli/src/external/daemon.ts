import { framePrompt } from './prompt.js';
import type { DaemonFrame, ExternalRuntime, ServerFrame } from './types.js';

export interface DaemonOptions {
  readonly wsUrl: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly runtime: ExternalRuntime;
  readonly cwd: string;
  readonly write: boolean;
  /** A fresh Oxy bearer for each handshake. */
  readonly getToken: () => Promise<string>;
  readonly log?: (message: string) => void;
  /** Reconnect backoff bounds; tests shrink them. */
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Consecutive failed handshakes before giving up. */
  readonly maxAuthFailures?: number;
}

export type DaemonExit =
  | { reason: 'stopped' }
  | { reason: 'revoked' }
  | { reason: 'unknown-agent' }
  | { reason: 'auth-failed' };

export interface Daemon {
  /** Resolves when the daemon will not reconnect any more. */
  readonly done: Promise<DaemonExit>;
  stop(): void;
}

/**
 * Holds the WebSocket to Alia open and answers the turns it receives, one at a time, by driving the
 * person's CLI. Outbound only: nothing listens on this machine.
 */
export function startDaemon(options: DaemonOptions): Daemon {
  const log = options.log ?? (() => undefined);
  const minBackoff = options.minBackoffMs ?? 1000;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const maxAuthFailures = options.maxAuthFailures ?? 5;

  let stopped = false;
  let socket: WebSocket | null = null;
  let backoff = minBackoff;
  let authFailures = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  const turns = new Map<string, AbortController>();
  let queue: Promise<void> = Promise.resolve();

  let finish!: (exit: DaemonExit) => void;
  const done = new Promise<DaemonExit>((resolve) => {
    finish = resolve;
  });

  const exit = (reason: DaemonExit) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnectTimer);
    for (const controller of turns.values()) controller.abort();
    socket?.close();
    finish(reason);
  };

  const send = (ws: WebSocket, frame: DaemonFrame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  const runTurn = async (
    ws: WebSocket,
    frame: Extract<ServerFrame, { type: 'turn' }>,
  ): Promise<void> => {
    const controller = new AbortController();
    turns.set(frame.turnId, controller);
    try {
      log(`turn ${frame.turnId.slice(0, 8)}: started`);
      const text = await options.runtime.run({
        prompt: framePrompt({
          agentName: options.agentName,
          task: frame.task,
          history: frame.history,
          write: options.write,
        }),
        cwd: options.cwd,
        write: options.write,
        signal: controller.signal,
        onDelta: (delta) => send(ws, { type: 'delta', turnId: frame.turnId, text: delta }),
      });
      if (controller.signal.aborted) return;
      if (text.trim() === '') {
        send(ws, { type: 'error', turnId: frame.turnId, message: 'The agent returned no answer' });
      } else {
        send(ws, { type: 'end', turnId: frame.turnId, text });
      }
      log(`turn ${frame.turnId.slice(0, 8)}: done`);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      log(`turn ${frame.turnId.slice(0, 8)}: failed — ${message}`);
      send(ws, { type: 'error', turnId: frame.turnId, message });
    } finally {
      turns.delete(frame.turnId);
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    let token: string;
    try {
      token = await options.getToken();
    } catch (err: unknown) {
      log(`could not get an Oxy token: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect(true);
      return;
    }
    if (stopped) return;

    const ws = new WebSocket(options.wsUrl);
    socket = ws;
    let authenticated = false;

    ws.onopen = () => {
      send(ws, { type: 'auth', token, agentId: options.agentId });
    };
    ws.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      switch (frame.type) {
        case 'auth-ok':
          authenticated = true;
          authFailures = 0;
          backoff = minBackoff;
          log('connected');
          break;
        case 'auth-error':
          log(`Alia refused the connection: ${frame.reason}`);
          if (frame.reason === 'unknown_agent') exit({ reason: 'unknown-agent' });
          break;
        case 'turn':
          if (!authenticated) return;
          // One turn at a time: two CLI runs in one directory would trample each other.
          queue = queue.then(() => runTurn(ws, frame));
          break;
        case 'cancel':
          turns.get(frame.turnId)?.abort();
          break;
        case 'revoked':
          log('this agent was removed in Alia');
          exit({ reason: 'revoked' });
          break;
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      for (const controller of turns.values()) controller.abort();
      if (stopped) return;
      log('disconnected');
      scheduleReconnect(!authenticated);
    };
    ws.onerror = () => undefined;
  };

  function scheduleReconnect(failedHandshake: boolean): void {
    if (stopped) return;
    if (failedHandshake) {
      authFailures += 1;
      if (authFailures >= maxAuthFailures) {
        log('giving up: Alia keeps refusing this connection');
        exit({ reason: 'auth-failed' });
        return;
      }
    }
    const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));
    backoff = Math.min(backoff * 2, maxBackoff);
    log(`reconnecting in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(() => void connect(), delay);
  }

  void connect();

  return { done, stop: () => exit({ reason: 'stopped' }) };
}
