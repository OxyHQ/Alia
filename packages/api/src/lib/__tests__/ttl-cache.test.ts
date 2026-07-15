import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTLCache } from '../ttl-cache.js';

describe('TTLCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('expiry', () => {
    it('returns a stored value before expiry and drops it after', () => {
      const cache = new TTLCache<number>({ ttlMs: 1000, maxSize: 10 });
      cache.set('a', 1);

      expect(cache.get('a')).toBe(1);
      vi.advanceTimersByTime(999);
      expect(cache.get('a')).toBe(1);
      vi.advanceTimersByTime(2);
      expect(cache.get('a')).toBeUndefined();
    });

    it('refreshes expiry when a key is re-set', () => {
      const cache = new TTLCache<number>({ ttlMs: 1000, maxSize: 10 });
      cache.set('a', 1);
      vi.advanceTimersByTime(800);
      cache.set('a', 2); // extends the deadline another 1000ms
      vi.advanceTimersByTime(800);
      expect(cache.get('a')).toBe(2);
    });
  });

  describe('maxSize eviction', () => {
    it('evicts the oldest entry when over capacity', () => {
      const cache = new TTLCache<string>({ ttlMs: 10_000, maxSize: 2 });
      cache.set('a', 'A');
      cache.set('b', 'B');
      cache.set('c', 'C'); // evicts 'a' (oldest)

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('B');
      expect(cache.get('c')).toBe('C');
    });

    it('re-inserting a key refreshes its recency so it survives eviction', () => {
      const cache = new TTLCache<string>({ ttlMs: 10_000, maxSize: 2 });
      cache.set('a', 'A');
      cache.set('b', 'B');
      cache.set('a', 'A2'); // 'a' is now newest, 'b' oldest
      cache.set('c', 'C'); // evicts 'b'

      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe('A2');
      expect(cache.get('c')).toBe('C');
    });
  });

  describe('sweep', () => {
    it('proactively removes expired entries on the interval (no get needed)', () => {
      const cache = new TTLCache<number>({ ttlMs: 1000, maxSize: 10, sweepIntervalMs: 500 });
      // Reach into the private store to prove the sweep — not a lazy get() —
      // dropped the entry.
      const store = (cache as unknown as { store: Map<string, unknown> }).store;

      cache.set('a', 1);
      expect(store.size).toBe(1);

      vi.advanceTimersByTime(1500); // past TTL and several sweep ticks
      expect(store.size).toBe(0);
    });
  });

  describe('getOrLoad single-flight', () => {
    it('shares one in-flight load across concurrent callers', async () => {
      vi.useRealTimers();
      const cache = new TTLCache<string>({ ttlMs: 1000, maxSize: 10 });

      let calls = 0;
      let resolveLoad: (v: string) => void = () => {};
      const load = () => {
        calls += 1;
        return new Promise<string>((resolve) => {
          resolveLoad = resolve;
        });
      };

      const p1 = cache.getOrLoad('k', load);
      const p2 = cache.getOrLoad('k', load);
      resolveLoad('value');

      await expect(Promise.all([p1, p2])).resolves.toEqual(['value', 'value']);
      expect(calls).toBe(1);
    });

    it('serves subsequent callers from cache after a load resolves', async () => {
      vi.useRealTimers();
      const cache = new TTLCache<string>({ ttlMs: 1000, maxSize: 10 });
      const load = vi.fn().mockResolvedValue('value');

      await cache.getOrLoad('k', load);
      await cache.getOrLoad('k', load);

      expect(load).toHaveBeenCalledTimes(1);
      expect(cache.get('k')).toBe('value');
    });

    it('does not cache a rejected load and retries on the next call', async () => {
      vi.useRealTimers();
      const cache = new TTLCache<string>({ ttlMs: 1000, maxSize: 10 });

      let calls = 0;
      const load = () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok');
      };

      await expect(cache.getOrLoad('k', load)).rejects.toThrow('boom');
      await expect(cache.getOrLoad('k', load)).resolves.toBe('ok');
      expect(calls).toBe(2);
    });
  });
});
