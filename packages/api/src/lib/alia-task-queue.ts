/**
 * Alia Task Queue — BullMQ jobs for scheduled tasks Alia runs herself.
 *
 * A task whose responsible actor is Alia has no agent and therefore no agent
 * session: its job carries the automation run id and the credit hold taken at
 * dispatch, and `alia-task-run.ts` does the rest. Separate from the
 * agent-sessions queue so neither starves the other. Pattern mirrors
 * task-queue.ts, including the direct-execution fallback without Redis.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { log } from './logger.js';
import { getRedisConnection } from './redis.js';
import type { CreditReservation } from './credits-manager.js';

// ── Types ──

export interface AliaTaskJobData {
  /** The claimed `automation_runs` row. Also the job id, so a run queues once. */
  runId: string;
  automationId: string;
  /** The task's owner, whom Alia acts for. */
  userId: string;
  /** Taken at dispatch; the runner settles it against the tokens spent. */
  creditReservation: CreditReservation;
}

export interface AliaTaskJobResult {
  runId: string;
  status: 'completed' | 'failed' | 'skipped';
}

// ── Queue name ──

const QUEUE_NAME = 'alia-tasks';
const ATTEMPTS = 2;

// ── Singleton instances ──

let queue: Queue<AliaTaskJobData, AliaTaskJobResult> | null = null;
let worker: Worker<AliaTaskJobData, AliaTaskJobResult> | null = null;
let redisAvailable = false;

async function processAliaTask(
  data: AliaTaskJobData,
  finalAttempt: boolean,
): Promise<AliaTaskJobResult> {
  const { runAliaTask } = await import('./alia-task-run.js');
  const status = await runAliaTask(data, { finalAttempt });
  return { runId: data.runId, status };
}

/**
 * Initialize the queue. Call once at server startup. Without Redis the queue
 * stays off and {@link enqueueAliaTask} runs the job directly.
 */
export async function initAliaTaskQueue(): Promise<void> {
  const connection = getRedisConnection();
  if (!connection) {
    log.general.info('REDIS_URL not set — Alia task queue disabled, using direct execution');
    return;
  }

  try {
    queue = new Queue<AliaTaskJobData, AliaTaskJobResult>(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
        removeOnFail: { age: 30 * 24 * 3600, count: 5000 },
      },
    });

    await queue.waitUntilReady();
    redisAvailable = true;
    log.general.info('Alia task queue initialized (BullMQ + Redis)');
  } catch (err) {
    log.general.warn({ err }, 'Failed to connect to Redis — Alia task queue disabled');
    queue = null;
    redisAvailable = false;
  }
}

/** Start the worker. Call once at server startup, after {@link initAliaTaskQueue}. */
export async function startAliaTaskWorker(): Promise<void> {
  const connection = getRedisConnection();
  if (!connection || !redisAvailable) return;

  worker = new Worker<AliaTaskJobData, AliaTaskJobResult>(
    QUEUE_NAME,
    async (job: Job<AliaTaskJobData, AliaTaskJobResult>) => {
      log.agents.info({ runId: job.data.runId, jobId: job.id }, 'Worker processing Alia task');
      // The runner refunds and tells the person only on the last attempt; an
      // earlier failure keeps the hold for the retry.
      const finalAttempt = job.attemptsMade >= (job.opts.attempts ?? ATTEMPTS) - 1;
      return processAliaTask(job.data, finalAttempt);
    },
    {
      connection,
      concurrency: 5,
      limiter: { max: 30, duration: 60_000 },
    },
  );

  worker.on('completed', (job) => {
    log.agents.info({ runId: job.data.runId, jobId: job.id }, 'Alia task job completed');
  });

  worker.on('failed', (job, err) => {
    log.agents.error({ runId: job?.data.runId, jobId: job?.id, err }, 'Alia task job failed');
  });

  worker.on('error', (err) => {
    log.agents.error({ err }, 'Alia task worker error');
  });

  log.general.info('Alia task queue worker started');
}

/**
 * Enqueue one Alia task run. Deduplicated by run id. Without Redis it runs
 * directly (fire-and-forget) as its only attempt.
 */
export async function enqueueAliaTask(
  data: AliaTaskJobData,
): Promise<{ queued: boolean; jobId?: string }> {
  if (queue && redisAvailable) {
    try {
      const job = await queue.add(`alia-task:${data.runId}`, data, { jobId: data.runId });
      log.agents.info({ runId: data.runId, jobId: job.id }, 'Alia task enqueued');
      return { queued: true, jobId: job.id ?? undefined };
    } catch (err) {
      log.agents.warn(
        { err, runId: data.runId },
        'Failed to enqueue an Alia task — falling back to direct',
      );
    }
  }

  processAliaTask(data, true).catch((err: unknown) => {
    log.agents.error({ err, runId: data.runId }, 'Direct Alia task failed');
  });
  return { queued: false };
}

/** Graceful shutdown. Call before process exit. */
export async function shutdownAliaTaskQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  redisAvailable = false;
}
