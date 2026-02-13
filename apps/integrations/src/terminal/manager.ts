/**
 * Terminal Manager — spawns sandboxed PTY sessions for AI command execution.
 * Streams output to connected WebSocket clients via xterm.js protocol.
 */

import type { IPty } from 'node-pty';

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

export async function runCommand(sessionId: string, command: string): Promise<string> {
  const session = await createSession(sessionId);

  return new Promise((resolve) => {
    let output = '';
    const marker = `__CMD_DONE_${Date.now()}__`;

    const handler = session.pty.onData((data: string) => {
      output += data;
      if (output.includes(marker)) {
        handler.dispose();
        // Extract output between command and marker
        const lines = output.split('\n');
        const markerIdx = lines.findIndex((l) => l.includes(marker));
        const cmdOutput = lines.slice(0, markerIdx).join('\n').trim();
        resolve(cmdOutput);
      }
    });

    // Send command with end marker
    session.pty.write(`${command}\necho "${marker}"\n`);

    // Safety timeout
    setTimeout(() => {
      handler.dispose();
      resolve(output.slice(0, 10000));
    }, 30000);
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
  const wss = (global as any).__wss;
  if (!wss) return;
  const message = JSON.stringify({ type: 'terminal', sessionId, data });
  for (const client of wss.clients) {
    if ((client as any).sessionId === sessionId && client.readyState === 1) {
      client.send(message);
    }
  }
}

function broadcastEvent(sessionId: string, type: string, data: any) {
  const wss = (global as any).__wss;
  if (!wss) return;
  const message = JSON.stringify({ type, sessionId, ...data });
  for (const client of wss.clients) {
    if ((client as any).sessionId === sessionId && client.readyState === 1) {
      client.send(message);
    }
  }
}

// Cleanup idle sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
      destroySession(id);
    }
  }
}, 60_000);
