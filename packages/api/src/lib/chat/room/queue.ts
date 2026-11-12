/**
 * Group room queue — BullMQ jobs, one per step of a room's chain (ADR 0025).
 *
 * Pattern of `lib/alia-task-queue.ts`, including the direct-execution fallback without Redis. The
 * queue only carries steps; the order inside a room is the room lock's job (`lock.ts`), so any
 * number of workers on any number of instances may take jobs and one room still speaks one member
 * at a time.
 */

import { type Job, Queue, Worker } from 'bullmq';
import { log } from '../../logger.js';
import { getRedisConnection } from '../../redis.js';
import type { RoomJobData } from './engine.js';

const QUEUE_NAME = 'group-rooms-v2';
const LEGACY_QUEUE_NAME = 'group-rooms';
/** A step that threw (database, lock) is retried once; the reply id makes the retry idempotent. */
const ATTEMPTS = 2;

let queue: Queue<RoomJobData> | null = null;
let worker: Worker<RoomJobData> | null = null;
let legacyWorker: Worker<RoomJobData> | null = null;
let legacyQueue: Queue<RoomJobData> | null = null;
let redisAvailable = false;

/** The id of a step's job: one per (chain, turn), so a step is queued once however often it is asked. */
export const jobIdOf = (
  data: Pick<RoomJobData, 'conversationId' | 'triggerId' | 'turns' | 'version' | 'phase'>,
) =>
  // BullMQ refuses ':' in a custom id.
  `room-${data.conversationId}-${data.triggerId}-${data.turns}${data.version === 2 ? `-${data.phase}` : ''}`.replace(
    /:/g,
    '_',
  );

async function processStep(data: RoomJobData): Promise<void> {
  const { roomRuntime } = await import('./runtime.js');
  await roomRuntime().processStep(data);
}

async function abandon(data: RoomJobData): Promise<void> {
  const { roomRuntime } = await import('./runtime.js');
  await roomRuntime().abandon(data);
}

/** Initialize the queue. Without Redis it stays off and {@link enqueueRoomJob} runs steps directly. */
export async function initRoomQueue(): Promise<void> {
  const connection = getRedisConnection();
  if (!connection) {
    log.general.info('REDIS_URL not set — group room queue disabled, using direct execution');
    return;
  }
  try {
    const defaultJobOptions = {
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 2000 },
    };
    queue = new Queue<RoomJobData>(QUEUE_NAME, { connection, defaultJobOptions });
    legacyQueue = new Queue<RoomJobData>(LEGACY_QUEUE_NAME, { connection, defaultJobOptions });
    await Promise.all([queue.waitUntilReady(), legacyQueue.waitUntilReady()]);
    redisAvailable = true;
    log.general.info('Group room queue initialized (BullMQ + Redis)');
  } catch (err) {
    log.general.warn({ err }, 'Failed to connect to Redis — group room queue disabled');
    queue = null;
    redisAvailable = false;
  }
}

/** Start the worker. Call once at startup, after {@link initRoomQueue}. */
export async function startRoomWorker(): Promise<void> {
  const connection = getRedisConnection();
  if (!connection || !redisAvailable) return;

  const makeWorker = (name: string) =>
    new Worker<RoomJobData>(
      name,
      async (job: Job<RoomJobData>) => {
        log.agents.info(
          { conversationId: job.data.conversationId, turn: job.data.turns, jobId: job.id },
          'Worker processing a group room step',
        );
        await processStep(job.data);
      },
      // Steps of different rooms run in parallel; steps of one room queue on its lock, so a high
      // concurrency would only park workers on a busy room.
      { connection, concurrency: 8 },
    );

  worker = makeWorker(QUEUE_NAME);
  legacyWorker = makeWorker(LEGACY_QUEUE_NAME);
  for (const running of [worker, legacyWorker]) {
    running.on('failed', (job, err) => {
      log.agents.error({ jobId: job?.id, err }, 'Group room step failed');
      if (job && job.attemptsMade >= (job.opts.attempts ?? ATTEMPTS)) {
        abandon(job.data).catch((abandonErr: unknown) =>
          log.agents.error(
            { err: abandonErr, jobId: job.id },
            'Could not abandon a group room chain',
          ),
        );
      }
    });
    running.on('error', (err) => {
      log.agents.error({ err }, 'Group room worker error');
    });
  }
  log.general.info('Group room queue workers started (v2 + legacy drain)');
}

/**
 * Queue one step. Deduplicated by chain and turn. Without Redis (or when the add fails) the step
 * runs directly, off the caller's stack: the room still lives past the request, in this process.
 */
export async function enqueueRoomJob(data: RoomJobData): Promise<void> {
  if (queue && redisAvailable) {
    try {
      const destination = data.version === 2 ? queue : legacyQueue;
      if (!destination) throw new Error('Room queue unavailable');
      await destination.add(`room:${data.conversationId}`, data, {
        jobId: jobIdOf(data),
        attempts: ATTEMPTS,
      });
      return;
    } catch (err) {
      // A lost Redis acknowledgement may have queued the selected turn already. Running it locally
      // would create a second execution with a possibly different selection. Retry the durable job.
      if (data.version === 2) throw err;
      log.agents.warn(
        { err, conversationId: data.conversationId },
        'Failed to enqueue a group room step — running it directly',
      );
    }
  }
  setImmediate(() => {
    processStep(data).catch((err: unknown) => {
      log.agents.error(
        { err, conversationId: data.conversationId },
        'Direct group room step failed',
      );
      abandon(data).catch(() => undefined);
    });
  });
}

/** Graceful shutdown. Call before process exit. */
export async function shutdownRoomQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (legacyWorker) {
    await legacyWorker.close();
    legacyWorker = null;
  }
  if (legacyQueue) {
    await legacyQueue.close();
    legacyQueue = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  redisAvailable = false;
}
