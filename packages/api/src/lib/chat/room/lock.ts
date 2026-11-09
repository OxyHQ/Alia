/**
 * The room lock: one turn at a time per room, across workers and instances (ADR 0025).
 *
 * Without it two chains of one room (a person who sent again while a member was still answering)
 * could run a member each at once, and their replies would interleave and answer a transcript the
 * other was changing. A job takes the room's lock for the whole of a step: read the transcript,
 * run the member, store the reply.
 */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { log } from '../../logger.js';
import { getRedisClient } from '../../redis.js';

export interface RoomLock {
  /** Runs `fn` when the room is free and holds it until `fn` settles. Waiters run in arrival order. */
  run<T>(roomKey: string, fn: () => Promise<T>): Promise<T>;
}

export const roomKeyOf = (userId: string, conversationId: string) => `${userId}:${conversationId}`;

/** Process-local lock: a promise chain per room. The no-Redis fallback and the test double. */
export function createLocalRoomLock(): RoomLock {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(roomKey, fn) {
      const previous = tails.get(roomKey) ?? Promise.resolve();
      const result = previous.then(fn, fn);
      const tail = result.catch(() => undefined);
      tails.set(roomKey, tail);
      void tail.then(() => {
        if (tails.get(roomKey) === tail) tails.delete(roomKey);
      });
      return result;
    },
  };
}

/** A lease longer than the slowest step (a member's turn is capped at 45 s), renewed while held. */
const LEASE_MS = 90_000;
const RENEW_MS = 20_000;
const POLL_MS = 250;
/** Longer than a few queued steps could take; past it the job fails and BullMQ retries it. */
const MAX_WAIT_MS = 4 * 60_000;

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0`;

/**
 * Cross-instance lock on Redis: `SET NX PX` with a per-holder token, renewed while the step runs and
 * released only by its holder. A holder that dies loses the room after the lease. Waiters poll; the
 * local lock sits in front so waiters of one process queue in order instead of all polling.
 */
export function createRedisRoomLock(
  redis: Redis,
  local: RoomLock = createLocalRoomLock(),
): RoomLock {
  const acquire = async (key: string, token: string): Promise<void> => {
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      if ((await redis.set(key, token, 'PX', LEASE_MS, 'NX')) === 'OK') return;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for room ${key}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };
  return {
    run(roomKey, fn) {
      const key = `alia:group-room-lock:${roomKey}`;
      return local.run(roomKey, async () => {
        const token = randomUUID();
        await acquire(key, token);
        const renew = setInterval(() => {
          redis.eval(RENEW, 1, key, token, String(LEASE_MS)).catch((err: unknown) => {
            log.general.warn({ err, key }, 'Could not renew a room lock');
          });
        }, RENEW_MS);
        try {
          return await fn();
        } finally {
          clearInterval(renew);
          await redis.eval(RELEASE, 1, key, token).catch((err: unknown) => {
            log.general.warn({ err, key }, 'Could not release a room lock; the lease will expire');
          });
        }
      });
    },
  };
}

let shared: RoomLock | null = null;

/** The process's lock: Redis when `REDIS_URL` is set, else process-local. */
export function getRoomLock(): RoomLock {
  if (shared) return shared;
  const redis = getRedisClient();
  shared = redis ? createRedisRoomLock(redis) : createLocalRoomLock();
  return shared;
}
