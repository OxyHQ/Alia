/**
 * Dependency-free TTL cache with insertion-order (LRU-ish) eviction and
 * single-flight loading.
 *
 * - Entries expire after `ttlMs`; a read past expiry misses and drops the entry.
 * - At `maxSize`, the oldest entry is evicted. Writing an existing key refreshes
 *   its recency (re-inserted as the newest entry).
 * - `getOrLoad` deduplicates concurrent loads of the same key into a single
 *   in-flight promise; a rejected load is never cached.
 * - A periodic sweep drops expired entries. Its timer is `unref`'d so it never
 *   keeps the process (or a test runner) alive.
 */
export class TTLCache<V> {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly store = new Map<string, { value: V; expires: number }>();
  private readonly inFlight = new Map<string, Promise<V>>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor({
    ttlMs,
    maxSize,
    sweepIntervalMs = 60_000,
  }: {
    ttlMs: number;
    maxSize: number;
    sweepIntervalMs?: number;
  }) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    // Never let the housekeeping timer hold the event loop open (AGENTS.md).
    this.sweepTimer.unref?.();
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    // Delete-then-set re-inserts at the tail so recency reflects the latest
    // write (Map preserves insertion order).
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }

  /**
   * Return the cached value, or run `load` to produce it. Concurrent callers
   * for the same key share one in-flight promise; if `load` rejects, the
   * failure is propagated but not cached, so the next call retries.
   */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const value = await load();
      this.set(key, value);
      return value;
    })();
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expires <= now) this.store.delete(key);
    }
  }
}
