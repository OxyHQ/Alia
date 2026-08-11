/**
 * Postgres-lease leader election.
 *
 * A single elected instance holds a time-boxed row in the `leases` table. The
 * lease is renewed on a heartbeat; if the holder dies, the lease expires
 * (evaluated against the PostgreSQL server clock, so instances don't need
 * synchronized wall clocks) and another instance takes over. This lets a cluster
 * of identical ECS tasks run at-most-one background worker (e.g. the
 * scheduled-trigger engine) without a dedicated coordinator.
 *
 * The single statement that decides an election lives in
 * `db/coordination/leaseRepository.ts`; everything here is the state machine
 * around it. The database handle is resolved per tick rather than captured at
 * start, so this module has the same signature it had on Mongo and
 * `trigger-engine.ts` did not have to learn about Postgres to keep working.
 */

import os from 'os';
import crypto from 'crypto';
import { acquireOrRenewLease, releaseLease } from '../db/coordination/leaseRepository.js';
import { getDb } from '../db/index.js';
import { log } from './logger.js';

/** Unique per process — hostname pins the ECS task, pid + random disambiguates restarts. */
const instanceId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

export interface LeaderElectionHooks {
  /** Called exactly once each time this instance becomes the leader. */
  onElected: () => void | Promise<void>;
  /** Called exactly once each time this instance loses leadership. */
  onDemoted: () => void | Promise<void>;
}

export interface LeaderElectionOptions {
  leaseTtlMs?: number;
  heartbeatMs?: number;
}

export interface LeaderElectionHandle {
  isLeader(): boolean;
  stop(): Promise<void>;
}

/**
 * Begin competing for leadership of `name`. Returns immediately; the first
 * acquisition attempt runs in the background on the next tick.
 */
export function startLeaderElection(
  name: string,
  hooks: LeaderElectionHooks,
  opts?: LeaderElectionOptions
): LeaderElectionHandle {
  const leaseTtlMs = opts?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const heartbeatMs = opts?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  let leader = false;
  let stopped = false;
  // Timestamp of the last renewal that reached the DB. While the DB is
  // unreachable we keep leading until the lease would have expired, then demote.
  let lastRenewOk = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Heartbeats that have reached the database and not yet come back.
   *
   * `stop()` waits for these, and that wait is the whole shutdown contract. A
   * renewal already at the server commits whenever the server gets to it, which
   * may be after the release — and it renews for a FULL TTL, so the lease this
   * instance just gave up is re-taken on its way out and the successor waits out
   * the entire TTL. That is the one thing `stop()` exists to prevent. The same
   * late tick also runs the state machine against a `leader` that `stop()` has
   * already set false, so a stopped handle elects itself and reports
   * `isLeader() === true` afterwards.
   *
   * Note there is deliberately NO `stopped` re-check inside `tick` instead: a
   * renewal that DID take the lease has to be allowed to record it, or `leader`
   * is false by the time `stop()` looks and the lease is never released at all.
   * Waiting is what makes the two orderings the same ordering.
   */
  const pending = new Set<Promise<void>>();

  async function runHook(kind: 'onElected' | 'onDemoted', fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.general.error({ err, lease: name, kind }, 'Leader election hook threw');
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      // `getDb()` throws when Postgres is not connected, which lands in the
      // catch below and is treated as unreachable — the same way a dropped
      // connection is. Losing the handle must never read as "somebody else is
      // the leader", because that would silently promote a second instance.
      const held = await acquireOrRenewLease(getDb(), name, instanceId, leaseTtlMs);
      lastRenewOk = Date.now();
      if (held && !leader) {
        leader = true;
        log.general.info({ lease: name, instanceId }, 'Leader election: elected');
        await runHook('onElected', hooks.onElected);
      } else if (!held && leader) {
        leader = false;
        log.general.info({ lease: name, instanceId }, 'Leader election: demoted (lease taken over)');
        await runHook('onDemoted', hooks.onDemoted);
      }
    } catch (err) {
      // DB unreachable. Keep leading through transient blips, but step down once
      // enough time has passed that our lease could have expired for others.
      log.general.warn({ err, lease: name }, 'Leader election: heartbeat failed');
      if (leader && Date.now() - lastRenewOk >= leaseTtlMs - heartbeatMs) {
        leader = false;
        log.general.warn({ lease: name, instanceId }, 'Leader election: demoted (lost contact with DB)');
        await runHook('onDemoted', hooks.onDemoted);
      }
    }
  }

  async function release(): Promise<void> {
    try {
      await releaseLease(getDb(), name, instanceId);
    } catch (err) {
      log.general.error({ err, lease: name }, 'Leader election: failed to release lease');
    }
  }

  /** One heartbeat, kept visible to `stop()` until it comes back. */
  function beat(): void {
    // `tick` handles every failure it can meet, so this settles rather than
    // rejecting and the bookkeeping needs no rejection path of its own.
    const run = tick();
    pending.add(run);
    void run.finally(() => pending.delete(run));
  }

  timer = setInterval(beat, heartbeatMs);
  timer.unref?.();
  // Kick off the first attempt immediately rather than waiting a full heartbeat.
  beat();

  return {
    isLeader: () => leader,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Clearing the timer above is synchronous, so nothing is added to
      // `pending` after this point and one wait is enough: every renewal
      // already at the database lands BEFORE the release is issued.
      await Promise.all([...pending]);
      if (leader) {
        leader = false;
        await runHook('onDemoted', hooks.onDemoted);
        await release();
      }
    },
  };
}
