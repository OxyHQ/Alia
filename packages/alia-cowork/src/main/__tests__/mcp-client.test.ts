import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The relay connection: the token is read at every connect (it is rotated in the background), a
 * dropped connection is retried with a growing delay, and a server whose command cannot be
 * spawned is dropped instead of crashing the main process.
 */

const world = vi.hoisted(() => ({
  token: 'token-1' as string | null,
  listeners: new Set<() => void>(),
  holdToolCalls: false,
  sockets: [] as {
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void;
    closed: boolean;
    sent: string[];
  }[],
  procs: [] as (EventEmitter & { stdin: EventEmitter & { write: unknown } })[],
  spawnFails: false,
}));

vi.mock('electron-store', () => ({
  default: class {
    get() {
      return undefined;
    }
  },
}));
vi.mock('../auth', () => ({
  currentAccessToken: () => world.token,
  linkedAliaClient: () => ({
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    getAccessToken: async (target: string) => {
      expect(target).toBe('wss://api.alia.onl/ws/mcp');
      return world.token;
    },
    dispose: vi.fn(),
  }),
  onSessionContextChange: (listener: () => void) => {
    world.listeners.add(listener);
    return () => world.listeners.delete(listener);
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
vi.mock('child_process', () => ({
  spawn: () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { write: unknown };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    proc.stdin = Object.assign(new EventEmitter(), {
      write: (message: string, callback?: (err?: Error) => void) => {
        callback?.();
        if (world.spawnFails) return true;
        const parsed = JSON.parse(message) as { id?: number; method?: string };
        if (world.holdToolCalls && parsed.method === 'tools/call') return true;
        if (parsed.id !== undefined) {
          const result = parsed.method === 'tools/list' ? { tools: [] } : {};
          queueMicrotask(() =>
            proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: parsed.id, result })}\n`)),
          );
        }
        return true;
      },
    });
    world.procs.push(proc);
    if (world.spawnFails) {
      queueMicrotask(() => proc.emit('error', new Error('spawn nope ENOENT')));
    }
    return proc;
  },
}));

import { McpLocalClient } from '../mcp-client';

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  closed = false;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  constructor() {
    world.sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

beforeEach(() => {
  world.token = 'token-1';
  world.listeners.clear();
  world.holdToolCalls = false;
  world.sockets.length = 0;
  world.procs.length = 0;
  world.spawnFails = false;
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        servers: [
          { _id: 's1', name: 'fs', runtime: 'local', enabled: true, config: { command: 'x' } },
        ],
      }),
    })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('McpLocalClient relay', () => {
  it('reads the token at every connect and backs off between attempts', async () => {
    const client = new McpLocalClient();
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    expect(world.sockets).toHaveLength(1);
    world.sockets[0].onopen?.();
    expect(JSON.parse(world.sockets[0].sent[0])).toMatchObject({ type: 'auth', token: 'token-1' });

    // The token rotates, and the connection drops: the reconnect carries the new one.
    world.token = 'token-2';
    world.sockets[0].onclose?.();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(world.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(world.sockets).toHaveLength(2);
    world.sockets[1].onopen?.();
    expect(JSON.parse(world.sockets[1].sent[0])).toMatchObject({ token: 'token-2' });

    // Dropped again before it was ever accepted: the wait doubles.
    world.sockets[1].onclose?.();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(world.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(world.sockets).toHaveLength(3);

    await client.shutdown();
  });

  it('does not reconnect once signed out', async () => {
    const client = new McpLocalClient();
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    world.token = null;
    world.sockets[0].onclose?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.sockets).toHaveLength(1);
    await client.shutdown();
  });

  it('account switch closes the relay and refuses a pending old tool result', async () => {
    const client = new McpLocalClient();
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    world.sockets[0].onopen?.();
    world.holdToolCalls = true;
    world.sockets[0].onmessage?.({
      data: JSON.stringify({
        type: 'tool-call',
        callId: 'old-call',
        serverId: 's1',
        toolName: 'read',
      }),
    });
    for (const listener of world.listeners) listener();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.sockets[0].closed).toBe(true);
    expect(world.sockets).toHaveLength(1);
    expect(world.sockets[0].sent.map((text) => JSON.parse(text).type)).toEqual(['auth']);
    expect(world.listeners.size).toBe(0);
  });

  it('a second start is a no-op while connected', async () => {
    const client = new McpLocalClient();
    const first = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await first;
    await client.start();
    expect(world.sockets).toHaveLength(1);
    expect(world.procs).toHaveLength(1);
    await client.shutdown();
  });
});

describe('McpLocalClient spawn', () => {
  it('survives a command that cannot be spawned', async () => {
    world.spawnFails = true;
    const client = new McpLocalClient();
    const started = client.start();
    // The process emits 'error' (a listener exists, so nothing is thrown) and the init times out.
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(started).resolves.toBeUndefined();
    expect(world.procs[0].listenerCount('error')).toBeGreaterThan(0);
    expect(world.procs[0].stdin.listenerCount('error')).toBeGreaterThan(0);
    await client.shutdown();
  });
});
