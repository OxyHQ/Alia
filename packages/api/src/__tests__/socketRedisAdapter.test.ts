import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server as HttpServer } from 'http';

/**
 * The Redis adapter is what makes a socket.io room cross ECS tasks — and it was
 * not attached in production.
 *
 * `lib/redis.ts` builds its clients without `lazyConnect`, so ioredis has
 * already begun connecting by the time `initSocket` sees them. The code called
 * `.connect()` on them anyway, which rejects with
 * `Redis is already connecting/connected`, and the rejection was caught and
 * downgraded to a warning — leaving every task on the in-memory adapter with
 * `desiredCount: 2`.
 *
 * That is why the fake clients below REJECT on `.connect()`: it is what the
 * real ones do, measured in production on both tasks. A fake that resolved
 * would pass against the broken code and prove nothing.
 */

const H = vi.hoisted(() => ({
  createAdapter: vi.fn(() => 'redis-adapter'),
  io: { adapter: vi.fn(), use: vi.fn(), on: vi.fn() },
  redis: { pub: null as unknown, sub: null as unknown },
}));
const { createAdapter, io, redis } = H;

vi.mock('@socket.io/redis-adapter', () => ({ createAdapter: H.createAdapter }));
// A constructor, not an arrow: `new Server(...)` is how socket.ts builds it.
vi.mock('socket.io', () => ({ Server: vi.fn(function () { return H.io; }) }));
vi.mock('../lib/redis.js', () => ({
  getRedisClient: () => H.redis.pub,
  getRedisSubClient: () => H.redis.sub,
}));

vi.mock('../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child, v1: child, chat: child } };
});
vi.mock('../middleware/auth.js', () => ({
  oxyClient: { authSocket: () => vi.fn() },
}));
vi.mock('../db/index.js', () => ({ getDb: () => ({}) }));
// `socket.ts` reads the agent's BOT ACCOUNT and asks Oxy whether the socket's
// user may act as it — the same gate the HTTP routes use — so this stands in
// for the projection rather than for a boolean ownership answer.
vi.mock('../db/agents/agentRepository.js', () => ({ findAgentOxyAccountId: vi.fn() }));
vi.mock('../lib/agent-account.js', () => ({ verifyAgentAccount: vi.fn() }));
vi.mock('../db/agents/agentSessionRepository.js', () => ({
  accountHasSessionWithAgent: vi.fn(),
  agentSessionIsOwnedBy: vi.fn(),
}));
vi.mock('../db/chat/canvasSessionRepository.js', () => ({ canvasSessionExists: vi.fn() }));
vi.mock('../db/automation/workflowRepository.js', () => ({ findExecutionOwner: vi.fn() }));

import { initSocket } from '../socket.js';

/** A client that behaves like the real one: already connecting, so `.connect()` rejects. */
function alreadyConnectingClient() {
  return {
    connect: vi.fn(async () => {
      throw new Error('Redis is already connecting/connected');
    }),
    on: vi.fn(),
    duplicate: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  redis.pub = null;
  redis.sub = null;
});

describe('the socket server crosses tasks', () => {
  it('attaches the Redis adapter even though the clients are already connecting', async () => {
    const pub = alreadyConnectingClient();
    const sub = alreadyConnectingClient();
    redis.pub = pub;
    redis.sub = sub;

    initSocket({} as HttpServer);
    // Attachment must not be deferred behind a promise either: a socket that
    // connects in that window would join rooms on the in-memory adapter.
    await Promise.resolve();

    expect(createAdapter).toHaveBeenCalledWith(pub, sub);
    expect(io.adapter).toHaveBeenCalledWith('redis-adapter');

    /**
     * The mutation this test exists for. `.connect()` on an already-connecting
     * ioredis client rejects, and awaiting it is what silently dropped the
     * adapter. Nothing here may call it.
     */
    expect(pub.connect).not.toHaveBeenCalled();
    expect(sub.connect).not.toHaveBeenCalled();
  });

  it('does not invent an adapter when there is no Redis', () => {
    // The negative control: without it, a test that always attaches an adapter
    // would pass for a build that attaches one unconditionally.
    initSocket({} as HttpServer);
    expect(createAdapter).not.toHaveBeenCalled();
    expect(io.adapter).not.toHaveBeenCalled();
  });
});
