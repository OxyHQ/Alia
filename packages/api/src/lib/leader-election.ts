/**
 * Mongo-lease leader election.
 *
 * A single elected instance holds a time-boxed lease document in the `leases`
 * collection. The lease is renewed on a heartbeat; if the holder dies, the lease
 * expires (evaluated against the MongoDB server clock, so instances don't need
 * synchronized wall clocks) and another instance takes over. This lets a
 * cluster of identical ECS tasks run at-most-one background worker (e.g. the
 * scheduled-trigger engine) without a dedicated coordinator.
 */

import os from 'os';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { log } from './logger.js';

/** Unique per process — hostname pins the ECS task, pid + random disambiguates restarts. */
const instanceId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

interface LeaseDoc {
  _id: string;
  holderId: string;
  expiresAt: Date;
  acquiredAt: Date;
}

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

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 11000
  );
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

  function leases() {
    return mongoose.connection.collection<LeaseDoc>('leases');
  }

  async function runHook(kind: 'onElected' | 'onDemoted', fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.general.error({ err, lease: name, kind }, 'Leader election hook threw');
    }
  }

  /**
   * Atomically claim or renew the lease in a single server-evaluated update.
   * Returns true iff this instance holds the lease afterwards.
   */
  async function tryAcquire(): Promise<boolean> {
    try {
      const doc = await leases().findOneAndUpdate(
        {
          _id: name,
          $or: [
            { holderId: instanceId },
            { $expr: { $lt: ['$expiresAt', '$$NOW'] } },
          ],
        },
        [
          {
            $set: {
              holderId: instanceId,
              expiresAt: { $add: ['$$NOW', leaseTtlMs] },
              // Preserve the original acquisition time across renewals; reset it
              // only when leadership actually changes hands.
              acquiredAt: {
                $cond: [{ $eq: ['$holderId', instanceId] }, '$acquiredAt', '$$NOW'],
              },
            },
          },
        ],
        { upsert: true, returnDocument: 'after' }
      );
      return doc?.holderId === instanceId;
    } catch (err) {
      // Lost the first-boot upsert race: another instance inserted the lease
      // between our filter miss and our upsert. Not the leader.
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const held = await tryAcquire();
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
      await leases().updateOne(
        { _id: name, holderId: instanceId },
        { $set: { expiresAt: new Date(0) } }
      );
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
