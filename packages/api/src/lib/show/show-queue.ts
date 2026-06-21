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
  showId: string;
  userId: string;
}

export interface ShowJobResult {
  showId: string;
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
      const { showId, userId } = job.data;
      log.general.info({ showId, jobId: job.id }, 'Processing show generation');

      try {
        const { runShowPipeline } = await import('./show-pipeline.js');
        await runShowPipeline(showId);
        return { showId, status: 'completed' };
      } catch (err: unknown) {
        log.general.error({ err, showId }, 'Show generation failed');

        // Pipeline already updates show status to 'failed' — just send notification
        try {
          const { sendNotification } = await import('../notification-service.js');
          await sendNotification({
            userId,
            type: 'agent_task_complete',
            title: 'Show Generation Failed',
            body: `Failed to generate show: ${getErrorMessage(err).slice(0, 200)}`,
            priority: 'high',
            data: { showId, status: 'failed' },
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
    log.general.info({ showId: job.data.showId, jobId: job.id }, 'Show job completed');
  });

  worker.on('failed', (job, err) => {
    log.general.error({ showId: job?.data.showId, jobId: job?.id, err }, 'Show job failed');
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
      const job = await queue.add(`show:${data.showId}`, data, {
        jobId: data.showId,
      });
      log.general.info({ showId: data.showId, jobId: job.id }, 'Show generation enqueued');
      return { queued: true, jobId: job.id ?? undefined };
    } catch (err) {
      log.general.warn({ err, showId: data.showId }, 'Failed to enqueue show — falling back to direct');
    }
  }

  // Fallback: direct execution
  const { runShowPipeline } = await import('./show-pipeline.js');
  runShowPipeline(data.showId).catch(err => {
    log.general.error({ err, showId: data.showId }, 'Direct show generation failed');
  });

  return { queued: false };
}

/**
 * Get show job status.
 */
export async function getShowJobStatus(showId: string): Promise<{
  state: string;
  progress: number;
} | null> {
  if (!queue || !redisAvailable) return null;

  try {
    const job = await queue.getJob(showId);
    if (!job) return null;

    const state = await job.getState();
    return {
      state,
      progress: typeof job.progress === 'number' ? job.progress : 0,
    };
  } catch {
    return null;
  }
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
