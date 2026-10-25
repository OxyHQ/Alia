import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The relay connection: the token is read at every connect (it is rotated in the background), a
 * dropped connection is retried with a growing delay, and a server whose command cannot be
 * spawned is dropped instead of crashing the main process.
 */

const world = vi.hoisted(() => ({
  token: 'token-1' as string | null,
  procs: [] as (EventEmitter & { stdin: EventEmitter & { write: unknown } })[],
  spawnFails: false,
  contextListeners: new Set<() => void>(),
}));

// The module captures `WebSocket` when it loads, so the stand-in is installed before the import.
vi.hoisted(() => {
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: () => void;
    onerror?: () => void;
    constructor() {
      (globalThis as unknown as { __sockets: FakeSocket[] }).__sockets.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
  }
  (globalThis as unknown as { __sockets: unknown[] }).__sockets = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
});
vi.mock('../logger', () => ({ log: { debug() {}, info() {}, warn() {}, error() {} } }));
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

const auth = {
  getAccessToken: async () => world.token,
  createLinkedClient: () => ({
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    getAccessToken: async (target: string) => {
      expect(target).toBe('wss://api.alia.onl/ws/mcp');
      return world.token;
    },
    dispose() {},
  }),
  onSessionContextChange: (listener: () => void) => {
    world.contextListeners.add(listener);
    return () => world.contextListeners.delete(listener);
  },
};

const sockets = (globalThis as unknown as { __sockets: FakeSocketLike[] }).__sockets;
interface FakeSocketLike {
  onopen?: () => void;
  onclose?: () => void;
  sent: string[];
}

beforeEach(() => {
  world.token = 'token-1';
  world.contextListeners.clear();
  sockets.length = 0;
  world.procs.length = 0;
  world.spawnFails = false;
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
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
    const client = new McpLocalClient(auth as never);
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ type: 'auth', token: 'token-1' });

    // The token rotates, and the connection drops: the reconnect carries the new one.
    world.token = 'token-2';
    sockets[0].onclose?.();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(2);
    sockets[1].onopen?.();
    expect(JSON.parse(sockets[1].sent[0])).toMatchObject({ token: 'token-2' });

    // Dropped again before it was ever accepted: the wait doubles.
    sockets[1].onclose?.();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(3);

    client.dispose();
  });

  it('stops an old account relay before a late socket open or reconnect', async () => {
    const client = new McpLocalClient(auth as never);
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    const oldSocket = sockets[0];
    world.token = 'account-b';
    for (const listener of [...world.contextListeners]) listener();
    oldSocket.onopen?.();
    oldSocket.onclose?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(oldSocket.sent).toEqual([]);
    expect(sockets).toHaveLength(1);
    expect(world.contextListeners.size).toBe(0);
    client.dispose();
  });

  it('does not reconnect once signed out', async () => {
    const client = new McpLocalClient(auth as never);
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    world.token = null;
    sockets[0].onclose?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
    client.dispose();
  });
});

describe('McpLocalClient spawn', () => {
  it('survives a command that cannot be spawned', async () => {
    world.spawnFails = true;
    const client = new McpLocalClient(auth as never);
    const started = client.start();
    // The process emits 'error' (a listener exists, so nothing is thrown) and the init times out.
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(started).resolves.toBeUndefined();
    expect(world.procs[0].listenerCount('error')).toBeGreaterThan(0);
    expect(world.procs[0].stdin.listenerCount('error')).toBeGreaterThan(0);
    client.dispose();
  });
});
