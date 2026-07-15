import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A shared in-memory stand-in for the `leases` collection that faithfully
 * reproduces the server-clock semantics of the aggregation-pipeline
 * findOneAndUpdate used by leader-election: a claim succeeds only when the
 * lease is unheld-by-us AND expired (or absent), and a non-matching upsert on
 * an existing _id raises an E11000 duplicate-key error.
 */
const h = vi.hoisted(() => {
  interface Lease {
    _id: string;
    holderId: string;
    expiresAt: Date;
    acquiredAt: Date;
  }
  interface AcquireUpdate {
    $set: { holderId: string; expiresAt: { $add: [unknown, number] }; acquiredAt: unknown };
  }

  const store = new Map<string, Lease>();
  // Controllable server clock powering `$$NOW`.
  const clock = { now: Date.now() };

  const collection = {
    findOneAndUpdate(
      filter: { _id: string },
      update: AcquireUpdate[],
      options?: { upsert?: boolean }
    ): Promise<Lease | null> {
      const id = filter._id;
      const set = update[0].$set;
      const candidate = set.holderId;
      const ttl = set.expiresAt.$add[1];
      const serverNow = new Date(clock.now);
      const doc = store.get(id);

      if (!doc) {
        if (!options?.upsert) return Promise.resolve(null);
        const created: Lease = { _id: id, holderId: candidate, expiresAt: new Date(clock.now + ttl), acquiredAt: serverNow };
        store.set(id, created);
        return Promise.resolve({ ...created });
      }

      const matches = doc.holderId === candidate || doc.expiresAt.getTime() < clock.now;
      if (matches) {
        const updated: Lease = {
          _id: id,
          holderId: candidate,
          expiresAt: new Date(clock.now + ttl),
          acquiredAt: doc.holderId === candidate ? doc.acquiredAt : serverNow,
        };
        store.set(id, updated);
        return Promise.resolve({ ...updated });
      }

      // upsert against an existing _id whose filter didn't match → duplicate key.
      const err = new Error('E11000 duplicate key error') as Error & { code: number };
      err.code = 11000;
      return Promise.reject(err);
    },
    updateOne(
      filter: { _id: string; holderId: string },
      update: { $set: { expiresAt: Date } }
    ): Promise<{ matchedCount: number }> {
      const doc = store.get(filter._id);
      if (doc && doc.holderId === filter.holderId) {
        doc.expiresAt = update.$set.expiresAt;
        return Promise.resolve({ matchedCount: 1 });
      }
      return Promise.resolve({ matchedCount: 0 });
    },
  };

  return { store, clock, collection };
});

vi.mock('mongoose', () => ({
  default: { connection: { collection: () => h.collection } },
}));

vi.mock('../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const LEASE = 'trigger-engine';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Each import (after resetModules) yields a module with its own random instanceId,
// so importing twice models two competing processes sharing one lease document.
async function loadInstance() {
  vi.resetModules();
  return import('../leader-election.js');
}

interface Handle {
  isLeader(): boolean;
  stop(): Promise<void>;
}

describe('leader-election', () => {
  const handles: Handle[] = [];

  beforeEach(() => {
    h.store.clear();
    h.clock.now = Date.now();
  });

  afterEach(async () => {
    await Promise.all(handles.map((handle) => handle.stop().catch(() => undefined)));
    handles.length = 0;
  });

  it('elects exactly one leader when two instances share one lease doc', async () => {
    const modA = await loadInstance();
    const modB = await loadInstance();

    const electedA = vi.fn();
    const electedB = vi.fn();
    const handleA = modA.startLeaderElection(LEASE, { onElected: electedA, onDemoted: vi.fn() }, { heartbeatMs: 10, leaseTtlMs: 60_000 });
    const handleB = modB.startLeaderElection(LEASE, { onElected: electedB, onDemoted: vi.fn() }, { heartbeatMs: 10, leaseTtlMs: 60_000 });
    handles.push(handleA, handleB);

    await wait(60);

    const leaders = (handleA.isLeader() ? 1 : 0) + (handleB.isLeader() ? 1 : 0);
    expect(leaders).toBe(1);
    expect(electedA.mock.calls.length + electedB.mock.calls.length).toBe(1);
  });

  it('fails over on lease expiry and demotes the stale leader on its next tick', async () => {
    const modA = await loadInstance();
    const modB = await loadInstance();

    const electedA = vi.fn();
    const demotedA = vi.fn();
    const electedB = vi.fn();
    const handleA = modA.startLeaderElection(LEASE, { onElected: electedA, onDemoted: demotedA }, { heartbeatMs: 10, leaseTtlMs: 60_000 });
    handles.push(handleA);

    await wait(40);
    expect(handleA.isLeader()).toBe(true);
    expect(electedA).toHaveBeenCalledTimes(1);

    // Force the lease to look expired to everyone, then bring up a second instance
    // whose immediate tick claims the now-expired lease before A can renew.
    const lease = h.store.get(LEASE);
    if (lease) lease.expiresAt = new Date(h.clock.now - 1000);

    const handleB = modB.startLeaderElection(LEASE, { onElected: electedB, onDemoted: vi.fn() }, { heartbeatMs: 10, leaseTtlMs: 60_000 });
    handles.push(handleB);

    await wait(60);

    expect(handleB.isLeader()).toBe(true);
    expect(electedB).toHaveBeenCalledTimes(1);
    // A's next renewal now finds a fresh foreign holder → E11000 → demote (once).
    expect(handleA.isLeader()).toBe(false);
    expect(demotedA).toHaveBeenCalledTimes(1);
  });

  it('releases the lease on stop()', async () => {
    const modA = await loadInstance();

    const demotedA = vi.fn();
    const handleA = modA.startLeaderElection(LEASE, { onElected: vi.fn(), onDemoted: demotedA }, { heartbeatMs: 10, leaseTtlMs: 60_000 });

    await wait(40);
    expect(handleA.isLeader()).toBe(true);

    await handleA.stop();

    expect(handleA.isLeader()).toBe(false);
    expect(demotedA).toHaveBeenCalledTimes(1);
    // Released leases carry an epoch-0 expiry so any competitor claims immediately.
    expect(h.store.get(LEASE)?.expiresAt.getTime()).toBe(0);
  });
});
