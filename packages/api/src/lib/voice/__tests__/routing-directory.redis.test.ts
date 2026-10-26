import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addressPolicy, createVoiceRouting, ROUTE_RENEW_MS } from '../routing-directory.js';

const url = process.env.TEST_REDIS_URL;
if (!url) throw new Error('TEST_REDIS_URL is required for real voice routing integration tests');
const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
const keys: string[] = [];
beforeAll(() => redis.connect());
afterEach(async () => {
  vi.useRealTimers();
  if (keys.length) await redis.del(...keys.splice(0));
});
afterAll(() => redis.quit());
function fixture() {
  const id = `vs_${randomUUID()}`;
  const key = `alia:voice-route:${id}`;
  keys.push(key);
  const routing = createVoiceRouting({
    address: '10.20.1.2',
    port: 3001,
    allows: addressPolicy('10.20.0.0/16'),
    redis,
  });
  return { id, key, routing };
}

describe('real Redis voice ownership leases', () => {
  it('publishes bounded metadata only, refuses another account and never steals an existing route', async () => {
    const f = fixture();
    const lease = await f.routing.register(f.id, 'account-A');
    try {
      expect(await f.routing.find(f.id, 'account-A')).toMatchObject({
        generation: f.routing.generation,
        address: '10.20.1.2',
      });
      expect(await f.routing.find(f.id, 'account-B')).toBeNull();
      expect(Object.keys(JSON.parse((await redis.get(f.key))!)).sort()).toEqual([
        'accountId',
        'address',
        'expiresAt',
        'generation',
      ]);
      expect(await redis.pttl(f.key)).toBeGreaterThan(0);
      expect(await redis.pttl(f.key)).toBeLessThanOrEqual(45_000);
      await expect(f.routing.register(f.id, 'account-B')).rejects.toThrow('owned');
    } finally {
      await lease.release();
    }
    expect(await redis.exists(f.key)).toBe(0);
  });
  it('cannot remove or renew a replacement lease, and cannot recreate an expired one', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = fixture();
    const lease = await f.routing.register(f.id, 'account-A');
    await redis.set(f.key, 'replacement', 'PX', 5000);
    await vi.advanceTimersByTimeAsync(ROUTE_RENEW_MS);
    // An independent command observes all preceding commands on this connection.
    await redis.ping();
    expect(await redis.pttl(f.key)).toBeLessThanOrEqual(5000);
    await lease.release();
    expect(await redis.get(f.key)).toBe('replacement');
    await redis.del(f.key);
    const second = await f.routing.register(f.id, 'account-A');
    await redis.del(f.key);
    await vi.advanceTimersByTimeAsync(ROUTE_RENEW_MS);
    await redis.ping();
    expect(await redis.exists(f.key)).toBe(0);
    await second.release();
  });
  it('refuses stale metadata and prevents arbitrary relay addresses or ports', async () => {
    const f = fixture();
    const lease = await f.routing.register(f.id, 'account-A');
    try {
      const route = (await f.routing.find(f.id, 'account-A'))!;
      expect(f.routing.peerUrl(route)).toBe('ws://10.20.1.2:3001/internal/voice/relay');
      expect(() => f.routing.peerUrl({ ...route, address: '169.254.169.254' })).toThrow();
      await redis.set(f.key, JSON.stringify({ ...route, expiresAt: Date.now() - 1 }));
      expect(await f.routing.find(f.id, 'account-A')).toBeNull();
    } finally {
      await redis.del(f.key);
      await lease.release();
    }
  });
});
