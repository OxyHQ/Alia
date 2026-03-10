/**
 * Task Queue — BullMQ-based async job queue for agent sessions.
 *
 * Allows agent tasks to run in the background:
 *   - User submits a task → job is enqueued → immediate response with sessionId
 *   - Worker picks up job → calls runAgentSession()
 *   - On completion/failure → user notified via notification-service
 *
 * Requires Redis (REDIS_URL env var). Falls back to direct execution if Redis
 * is unavailable (graceful degradation for dev environments).
 */

import { Queue, Worker, type Job } from 'bullmq';
import { log } from './logger.js';

// ── Types ──

export interface AgentJobData {
  sessionId: string;
  userId: string;
  agentId: string;
  agentName: string;
}

export interface AgentJobResult {
  sessionId: string;
  status: 'completed' | 'failed';
  result?: string;
}

// ── Queue name ──

const QUEUE_NAME = 'agent-sessions';

// ── Redis connection (shared) ──

import { getRedisConnection } from './redis.js';

// ── Singleton instances ──

let queue: Queue<AgentJobData, AgentJobResult> | null = null;
let worker: Worker<AgentJobData, AgentJobResult> | null = null;
let redisAvailable = false;

/**
 * Initialize the task queue. Call once at server startup.
 * If Redis is not configured, the queue won't start and
 * `enqueueAgentSession` will fall back to direct execution.
 */
export async function initTaskQueue(): Promise<void> {
  const connection = getRedisConnection();
  if (!connection) {
    log.general.info('REDIS_URL not set — task queue disabled, using direct execution');
    return;
  }

  try {
    queue = new Queue<AgentJobData, AgentJobResult>(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
        removeOnFail: { age: 30 * 24 * 3600, count: 5000 },
      },
    });

    // Test connection
    await queue.waitUntilReady();
    redisAvailable = true;
    log.general.info('Task queue initialized (BullMQ + Redis)');
  } catch (err) {
    log.general.warn({ err }, 'Failed to connect to Redis — task queue disabled');
    queue = null;
    redisAvailable = false;
  }
}

/**
 * Start the worker that processes agent session jobs.
 * Call once at server startup, after initTaskQueue().
 */
export async function startWorker(): Promise<void> {
  const connection = getRedisConnection();
  if (!connection || !redisAvailable) return;

  worker = new Worker<AgentJobData, AgentJobResult>(
    QUEUE_NAME,
    async (job: Job<AgentJobData, AgentJobResult>) => {
      const { sessionId, userId, agentId, agentName } = job.data;
      log.agents.info({ sessionId, jobId: job.id }, 'Worker processing agent session');

      try {
        // Lazy import to avoid circular deps
        const { runAgentSession } = await import('./agent-runner.js');
        await runAgentSession(sessionId);

        // Read final status from DB
        const { AgentSession } = await import('../models/agent-session.js');
        const session = await AgentSession.findById(sessionId).select('status result').lean();

        const status = session?.status === 'completed' ? 'completed' : 'failed';
        const result = session?.result || 'Task finished.';

        // Send notification
        try {
          const { sendNotification } = await import('./notification-service.js');
          await sendNotification({
            userId,
            type: 'agent_task_complete',
            title: `${agentName} finished`,
            body: result.slice(0, 500),
            data: { sessionId, agentId, status },
          });
        } catch (notifErr) {
          log.agents.warn({ notifErr, sessionId }, 'Failed to send completion notification');
        }

        return { sessionId, status, result };
      } catch (err: any) {
        log.agents.error({ err, sessionId }, 'Worker: agent session failed');

        // Send failure notification on final attempt
        if (job.attemptsMade >= (job.opts.attempts || 2) - 1) {
          try {
            const { sendNotification } = await import('./notification-service.js');
            await sendNotification({
              userId,
              type: 'agent_task_complete',
              title: `${agentName} failed`,
              body: `Task failed: ${err.message?.slice(0, 200) || 'Unknown error'}`,
              priority: 'high',
              data: { sessionId, agentId, status: 'failed' },
            });
          } catch {
            // Notification failure shouldn't block
          }
        }

        throw err; // Let BullMQ handle retry
      }
    },
    {
      connection,
      concurrency: 5, // Up to 5 agent sessions in parallel
      limiter: {
        max: 30,
        duration: 60_000, // Max 30 jobs per minute
      },
    },
  );

  worker.on('completed', (job) => {
    log.agents.info({ sessionId: job.data.sessionId, jobId: job.id }, 'Agent job completed');
  });

  worker.on('failed', (job, err) => {
    log.agents.error({ sessionId: job?.data.sessionId, jobId: job?.id, err }, 'Agent job failed');
  });

  worker.on('error', (err) => {
    log.agents.error({ err }, 'Worker error');
  });

  log.general.info('Task queue worker started');
}

/**
 * Enqueue an agent session for async execution.
 *
 * If Redis is available, adds the job to BullMQ and returns immediately.
 * If Redis is unavailable, falls back to direct (fire-and-forget) execution.
 *
 * @returns `{ queued: true, jobId }` if enqueued, `{ queued: false }` if direct.
 */
export async function enqueueAgentSession(
  data: AgentJobData,
): Promise<{ queued: boolean; jobId?: string }> {
  if (queue && redisAvailable) {
    try {
      const job = await queue.add(`session:${data.sessionId}`, data, {
        jobId: data.sessionId, // Dedup by sessionId
      });
      log.agents.info({ sessionId: data.sessionId, jobId: job.id }, 'Agent session enqueued');
      return { queued: true, jobId: job.id ?? undefined };
    } catch (err) {
      log.agents.warn({ err, sessionId: data.sessionId }, 'Failed to enqueue — falling back to direct');
    }
  }

  // Fallback: direct execution (fire-and-forget)
  const { runAgentSession } = await import('./agent-runner.js');
  runAgentSession(data.sessionId).catch(err => {
    log.agents.error({ err, sessionId: data.sessionId }, 'Direct agent session failed');
  });

  return { queued: false };
}

/**
 * Get job status by sessionId.
 */
export async function getJobStatus(sessionId: string): Promise<{
  state: string;
  progress: number;
  attemptsMade: number;
  failedReason?: string;
} | null> {
  if (!queue || !redisAvailable) return null;

  try {
    const job = await queue.getJob(sessionId);
    if (!job) return null;

    const state = await job.getState();
    return {
      state,
      progress: typeof job.progress === 'number' ? job.progress : 0,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
    };
  } catch {
    return null;
  }
}

/**
 * Cancel a queued/active job.
 */
export async function cancelJob(sessionId: string): Promise<boolean> {
  if (!queue || !redisAvailable) return false;

  try {
    const job = await queue.getJob(sessionId);
    if (!job) return false;

    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') {
      await job.remove();
      return true;
    }
    // Can't cancel active jobs directly — session cancellation
    // is handled via session.status = 'cancelled' in the runner
    return false;
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown. Call before process exit.
 */
export async function shutdownTaskQueue(): Promise<void> {
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

/** Check if the task queue is using Redis (vs direct execution fallback) */
export function isQueueActive(): boolean {
  return redisAvailable;
}
