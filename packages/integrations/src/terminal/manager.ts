/**
 * Terminal Manager — spawns sandboxed PTY sessions for AI command execution.
 * Streams output to connected WebSocket clients via xterm.js protocol.
 */

import type { IPty } from 'node-pty';
import { getWss, type SessionWebSocket } from '../realtime/wss-global';

interface TerminalSession {
  pty: IPty;
  sessionId: string;
  createdAt: number;
  lastActivity: number;
}

const sessions = new Map<string, TerminalSession>();
const MAX_SESSIONS = 10;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function createSession(sessionId: string): Promise<TerminalSession> {
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId)!;
  }

  if (sessions.size >= MAX_SESSIONS) {
    // Kill oldest session
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastActivity < oldestTime) {
        oldestTime = s.lastActivity;
        oldest = id;
      }
    }
    if (oldest) destroySession(oldest);
  }

  // Dynamic import for node-pty (native module)
  const pty = await import('node-pty');

  const shell = process.env.SHELL || '/bin/bash';
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: '/tmp',
    env: {
      ...getSandboxedEnv(),
      TERM: 'xterm-256color',
    },
  });

  const session: TerminalSession = {
    pty: term,
    sessionId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  // Stream PTY output to WebSocket clients
  term.onData((data: string) => {
    session.lastActivity = Date.now();
    broadcastTerminal(sessionId, data);
  });

  term.onExit(() => {
    sessions.delete(sessionId);
    broadcastEvent(sessionId, 'terminal_exit', {});
  });

  sessions.set(sessionId, session);
  return session;
}

export function writeToSession(sessionId: string, data: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.lastActivity = Date.now();
  session.pty.write(data);
  return true;
}

const COMMAND_TIMEOUT_MS = 30_000;

/**
 * One command at a time per session, so two callers cannot interleave.
 *
 * A PTY is a single stream. Two `runCommand` calls on one session used to
 * write both commands into it and accumulate BOTH outputs into each other's
 * buffer, so each caller got some mixture of the two. Chaining per session is
 * the only correct answer short of one PTY per command.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Marker text the terminal's own echo cannot forge.
 *
 * The PTY echoes input back before the shell has run anything, so the previous
 * implementation resolved on its own echo of `echo "__CMD_DONE_…__"` and
 * returned the echoed command line as the command's "output" — for every
 * command, not as an edge case.
 *
 * Splitting the literal in the SOURCE is what fixes it: the shell concatenates
 * `"__CMD" "_START_x__"` into a contiguous `__CMD_START_x__` when it prints,
 * while the echoed line keeps the quotes between the halves. So a search for
 * the contiguous form matches the shell's output and can never match the echo.
 */
export function markerPair(id: string): {
  start: string;
  end: string;
  startEcho: string;
  endEcho: string;
} {
  return {
    start: `__CMD_START_${id}__`,
    end: `__CMD_END_${id}__`,
    startEcho: `echo "__CMD""_START_${id}__"`,
    endEcho: `echo "__CMD""_END_${id}__"`,
  };
}

export async function runCommand(sessionId: string, command: string): Promise<string> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => runCommandNow(sessionId, command));
  queues.set(sessionId, run);
  try {
    return await run;
  } finally {
    // Only clear the slot if nothing queued behind this call, or the next
    // caller would lose its place in the chain.
    if (queues.get(sessionId) === run) queues.delete(sessionId);
  }
}

async function runCommandNow(sessionId: string, command: string): Promise<string> {
  const session = await createSession(sessionId);

  return new Promise((resolve) => {
    let output = '';
    const id = `${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
    const { start, end, startEcho, endEcho } = markerPair(id);

    let settled = false;
    // Declared before the handler so the handler can clear it. Leaving it to
    // fire regardless kept a 30-second timer alive for every command the
    // service ever ran.
    let timer: NodeJS.Timeout | undefined;

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      handler.dispose();
      resolve(value);
    };

    const handler = session.pty.onData((data: string) => {
      output += data;
      const endIndex = output.indexOf(end);
      if (endIndex === -1) return;

      // Strictly between the two printed markers: everything before `start` is
      // the terminal's echo of the input, and everything after `end` belongs to
      // whatever runs next.
      const startIndex = output.indexOf(start);
      const body =
        startIndex === -1 ? output.slice(0, endIndex) : output.slice(startIndex + start.length, endIndex);
      finish(body.trim());
    });

    session.pty.write(`${startEcho}\n${command}\n${endEcho}\n`);

    timer = setTimeout(() => {
      finish(output.slice(0, 10000));
    }, COMMAND_TIMEOUT_MS);
  });
}

export function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.pty.kill();
    sessions.delete(sessionId);
  }
}

export function shutdown(): void {
  for (const [id] of sessions) {
    destroySession(id);
  }
}

function getSandboxedEnv(): Record<string, string> {
  return {
    HOME: '/tmp',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    // Exclude sensitive env vars
  };
}

function broadcastTerminal(sessionId: string, data: string) {
  const wss = getWss();
  if (!wss) return;
  const message = JSON.stringify({ type: 'terminal', sessionId, data });
  for (const client of wss.clients) {
    const ws = client as SessionWebSocket;
    if (ws.sessionId === sessionId && ws.readyState === 1) {
      ws.send(message);
    }
  }
}

function broadcastEvent(sessionId: string, type: string, data: Record<string, unknown>) {
  const wss = getWss();
  if (!wss) return;
  const message = JSON.stringify({ type, sessionId, ...data });
  for (const client of wss.clients) {
    const ws = client as SessionWebSocket;
    if (ws.sessionId === sessionId && ws.readyState === 1) {
      ws.send(message);
    }
  }
}

// Cleanup idle sessions
const idleSessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
      destroySession(id);
    }
  }
}, 60_000);
idleSessionCleanupTimer.unref?.();
