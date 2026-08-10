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

  timer = setInterval(() => { void tick(); }, heartbeatMs);
  timer.unref?.();
  // Kick off the first attempt immediately rather than waiting a full heartbeat.
  void tick();

  return {
    isLeader: () => leader,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (leader) {
        leader = false;
        await runHook('onDemoted', hooks.onDemoted);
        await release();
      }
    },
  };
}
