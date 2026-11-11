import { framePrompt } from './prompt.js';
import type { SessionStore } from './state.js';
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
  /** The CLI's own sessions per conversation. Omitted: every turn starts fresh. */
  readonly sessions?: SessionStore;
  /** Consecutive failed handshakes before giving up. */
  readonly maxAuthFailures?: number;
}

type DaemonExit =
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
      const sessionKey =
        options.sessions && options.runtime.resumes && frame.threadKey
          ? `${options.agentId}:${frame.threadKey}`
          : undefined;
      let emitted = false;
      const attempt = (resumeId: string | undefined) =>
        options.runtime.run({
          prompt: framePrompt({
            agentName: options.agentName,
            task: frame.task,
            // A resumed session already holds the conversation; a fresh one needs it spelled out.
            history: resumeId ? [] : frame.history,
            write: options.write,
            resumed: resumeId !== undefined,
          }),
          cwd: options.cwd,
          write: options.write,
          signal: controller.signal,
          ...(resumeId ? { resumeId } : {}),
          onSession: (id) => {
            if (sessionKey) options.sessions?.set(sessionKey, id);
          },
          onDelta: (delta) => {
            emitted = true;
            send(ws, { type: 'delta', turnId: frame.turnId, text: delta });
          },
        });
      const resumeId = sessionKey ? options.sessions?.get(sessionKey) : undefined;
      let text: string;
      try {
        text = await attempt(resumeId);
        if (resumeId && text.trim() === '' && !emitted) throw new Error('empty resumed answer');
      } catch (err: unknown) {
        // The CLI lost that session (cleared, expired): start over with the conversation spelled out.
        if (!resumeId || emitted || controller.signal.aborted) throw err;
        log('could not resume the CLI session; starting a new one');
        if (sessionKey) options.sessions?.delete(sessionKey);
        text = await attempt(undefined);
      }
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
