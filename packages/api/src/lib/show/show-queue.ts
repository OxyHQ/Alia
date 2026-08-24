/**
 * Show Queue — BullMQ-based async job queue for show generation.
 *
 * Separate from the agent-sessions queue to avoid resource contention.
 * Pattern mirrors task-queue.ts.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { getRedisConnection } from '../redis.js';

// ── Types ──

export interface ShowJobData {
  /** A `show_episodes` row. One job produces one episode. */
  episodeId: string;
  userId: string;
}

export interface ShowJobResult {
  episodeId: string;
  status: 'completed' | 'failed';
}

// ── Queue name ──

const QUEUE_NAME = 'show-generation';

// ── Singleton instances ──

let queue: Queue<ShowJobData, ShowJobResult> | null = null;
let worker: Worker<ShowJobData, ShowJobResult> | null = null;
let redisAvailable = false;

/**
 * Initialize the show queue. Call once at server startup.
 */
export async function initShowQueue(): Promise<void> {
  const connection = getRedisConnection();
  if (!connection) {
    log.general.info('REDIS_URL not set — show queue disabled');
    return;
  }

  try {
    queue = new Queue<ShowJobData, ShowJobResult>(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 1, // No auto-retry — too expensive
        removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
        removeOnFail: { age: 30 * 24 * 3600, count: 1000 },
      },
    });

    await queue.waitUntilReady();
    redisAvailable = true;
    log.general.info('Show queue initialized');
  } catch (err) {
    log.general.warn({ err }, 'Failed to connect to Redis — show queue disabled');
    queue = null;
    redisAvailable = false;
  }
}

/**
 * Start the worker that processes show generation jobs.
 */
export async function startShowWorker(): Promise<void> {
  const connection = getRedisConnection();
  if (!connection || !redisAvailable) return;

  worker = new Worker<ShowJobData, ShowJobResult>(
    QUEUE_NAME,
    async (job: Job<ShowJobData, ShowJobResult>) => {
      const { episodeId, userId } = job.data;
      log.general.info({ episodeId, jobId: job.id }, 'Producing a show episode');

      try {
        const { runShowPipeline } = await import('./show-pipeline.js');
        await runShowPipeline(episodeId);
        return { episodeId, status: 'completed' };
      } catch (err: unknown) {
        log.general.error({ err, episodeId }, 'Episode generation failed');

        // Pipeline already updates show status to 'failed' — just send notification
        try {
          const { sendNotification } = await import('../notification-service.js');
          await sendNotification({
            userId,
            type: 'agent_task_complete',
            title: 'Episode Generation Failed',
            body: `Failed to generate the episode: ${getErrorMessage(err).slice(0, 200)}`,
            priority: 'high',
            data: { episodeId, status: 'failed' },
          });
        } catch { /* notification failure is non-fatal */ }

        throw err;
      }
    },
    {
      connection,
      concurrency: 3,
      limiter: {
        max: 10,
        duration: 60_000,
      },
    },
  );

  worker.on('completed', (job) => {
    log.general.info({ episodeId: job.data.episodeId, jobId: job.id }, 'Show job completed');
  });

  worker.on('failed', (job, err) => {
    log.general.error({ episodeId: job?.data.episodeId, jobId: job?.id, err }, 'Show job failed');
  });

  worker.on('error', (err) => {
    log.general.error({ err }, 'Show worker error');
  });

  log.general.info('Show queue worker started');
}

/**
 * Enqueue a show generation job.
 *
 * If Redis is unavailable, falls back to direct (fire-and-forget) execution.
 */
export async function enqueueShowGeneration(
  data: ShowJobData,
): Promise<{ queued: boolean; jobId?: string }> {
  if (queue && redisAvailable) {
    try {
      const job = await queue.add(`show:${data.episodeId}`, data, {
        jobId: data.episodeId,
      });
      log.general.info({ episodeId: data.episodeId, jobId: job.id }, 'Episode generation enqueued');
      return { queued: true, jobId: job.id ?? undefined };
    } catch (err) {
      log.general.warn({ err, episodeId: data.episodeId }, 'Failed to enqueue an episode — falling back to direct');
    }
  }

  // Fallback: direct execution
  const { runShowPipeline } = await import('./show-pipeline.js');
  runShowPipeline(data.episodeId).catch(err => {
    log.general.error({ err, episodeId: data.episodeId }, 'Direct episode generation failed');
  });

  return { queued: false };
}

/**
 * Graceful shutdown.
 */
export async function shutdownShowQueue(): Promise<void> {
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
