/**
 * The work this service does beside serving requests, and its shutdown half.
 *
 * ## Why this is a module rather than nine statements in `src/index.ts`
 *
 * The same reason `lib/boot-guards.ts` is a module. Nothing imports
 * `src/index.ts`, because importing it opens a socket, so anything written
 * there can only be guarded by a source-text census — and a census is exactly
 * what could not tell that this function had **never run in production**.
 *
 * It sat behind `connectDB().then(...)`. `MONGODB_URI` left the task definition
 * when Mongo was decommissioned, so the retry loop backed off forever and the
 * trigger engine, the moderation-outbox dispatcher, both queues and the
 * container pool never started once. Every assertion anyone had was about the
 * TEXT of that code, and the text was correct throughout.
 *
 * Moving these starters is safe for the reason the boot guards' move was: they
 * touch none of `app`, `server` or `io`, so nothing about WHEN anything happens
 * changes. What it buys is `__tests__/background-services.test.ts`, which
 * asserts against the real functions which services start, in what order, and
 * that every one of them is stopped again.
 *
 * ## Nothing here has a store precondition left to wait on
 *
 * `runBootGuards` refuses to start the process without `DATABASE_URL` before
 * `listen` is reached, so the Postgres pool is connected by the time this runs.
 * Everything below either reads Postgres or is self-gating on its own
 * dependency: `REDIS_URL` for the two queues, a reachable sandbox host for the
 * container pool, `CROWDSOURCE_ENABLED` for the dispatcher, `GATEWAY_API_URL`
 * for the gateway warmup. None of them reads Mongo — `db/__tests__/
 * bootWiring.test.ts` walks the import graph from `src/index.ts` and asserts
 * that, rather than leaving it as a claim in this comment.
 *
 * ## What is deliberately NOT here
 *
 * Seeding. `scripts/seed.ts` owns it at the deploy boundary, for the reasons
 * that file sets out; `seedBots()` used to be called from here and is now
 * called from nowhere, which `db/__tests__/seedWiring.test.ts` records as a
 * named exemption rather than an accident.
 */

import { getDb } from '../db/index.js';
import { failOrphanedAudioJobs } from '../db/notifications/audioJobRepository.js';
import { syncZeroEval } from '../scripts/sync-zeroeval.js';
import { moderationOutboxDispatcher } from './crowdsource/dispatcher.js';
import { warmupGatewayClient } from './gateway-client.js';
import { log } from './logger.js';
import { reclaimOrphanedAgentSessions } from './agent/session-handoff.js';
import { getContainerPool, shutdownContainerPool } from './sandbox/container-pool.js';
import { initShowQueue, shutdownShowQueue, startShowWorker } from './show/show-queue.js';
import { initTaskQueue, shutdownTaskQueue, startWorker } from './task-queue.js';
import { startSkillRegistrySync, stopSkillRegistrySync } from './skills/scheduler.js';
import { startTriggerEngine, stopTriggerEngine } from './trigger-engine.js';

/**
 * Start everything, without blocking the caller.
 *
 * Every one of these is fire-and-forget on purpose: this runs inside the
 * `server.listen` callback, and a starter that rejected while being awaited
 * would take the socket down with it. A failure is logged and the rest still
 * start.
 */
export function startBackgroundServices(): void {
  // Warm up gateway client cache (non-blocking)
  warmupGatewayClient().catch((err) => log.general.error({ err }, '[Gateway] Client warmup error'));
  // Sync external models in background (non-blocking)
  syncZeroEval().catch((err) => log.general.error({ err }, '[ZeroEval] Background sync error'));
  // Start trigger engine under leader election (non-blocking) — only the
  // elected instance runs the scheduler, so triggers fire once across tasks.
  startTriggerEngine();
  // Drain the moderation outbox. Deliberately NOT leader-gated: every event is
  // claimed under a lease with an owner check, so N tasks share the work and a
  // dead task's lease is reclaimed rather than stranding a report. No-ops when
  // the integration is disabled — the loop is gated, never the durable record.
  moderationOutboxDispatcher.start();
  // Initialize task queue for async agent sessions (non-blocking)
  initTaskQueue()
    .then(() => startWorker())
    .catch((err) => log.general.error({ err }, '[TaskQueue] Startup error'));
  // Pre-warm agent containers when the Docker host is configured.
  getContainerPool()
    .initialize()
    .catch((err) => log.general.error({ err }, '[ContainerPool] Startup error'));
  // Clean up orphaned audio jobs from previous process crashes (non-blocking).
  failOrphanedAudioJobs(getDb())
    .then((count) => {
      if (count > 0) log.general.info({ count }, 'Cleaned up orphaned audio jobs');
    })
    .catch((err) => log.general.error({ err }, '[AudioJob] Orphan cleanup error'));
  /**
   * Give back the credits of agent sessions a previous process enqueued and
   * nothing ever ran (non-blocking).
   *
   * The same event as the line above, one table over, and it costs money rather
   * than a stuck spinner: hiring an agent DEBITS its price, and the worker that
   * would settle it never arrives. Not leader-gated, because the claim is the
   * UPDATE — every task may run it and each row is returned to exactly one of
   * them.
   */
  reclaimOrphanedAgentSessions()
    .then((refunded) => {
      if (refunded > 0) log.general.warn({ refunded }, 'Refunded agent sessions that were never picked up');
    })
    .catch((err) => log.general.error({ err }, '[AgentSession] Orphan reclaim error'));
  // Initialize show generation queue (non-blocking)
  initShowQueue()
    .then(() => startShowWorker())
    .catch((err) => log.general.error({ err }, '[ShowQueue] Startup error'));
  // Keep the shared skill catalogue in step with the repositories it is synced
  // from. Leader-gated, because it writes rows every account reads.
  startSkillRegistrySync();
}

/**
 * Stop everything {@link startBackgroundServices} started, in the order the
 * shutdown handler has always used.
 *
 * Awaited rather than fire-and-forget, and the leader lease is why: an instance
 * that exits still holding the trigger-engine lease leaves every other task
 * waiting out its TTL before anything is scheduled again.
 *
 * Rejections propagate to the caller, which is `src/index.ts`'s shutdown
 * handler — it logs and exits non-zero. The 30s force-exit timer there is what
 * bounds this.
 */
export async function stopBackgroundServices(): Promise<void> {
  // Release the trigger-engine leadership lease and stop scheduled tasks
  await stopTriggerEngine();
  log.general.info('Trigger engine stopped');

  // Same for the skill catalogue's own lease.
  await stopSkillRegistrySync();
  log.general.info('Skill registry sync stopped');

  // Stop claiming moderation work, but let the event already in flight reach a
  // durable state — an abandoned claim is reclaimable, a half-applied one is not.
  await moderationOutboxDispatcher.stop();
  log.general.info('Moderation outbox dispatcher stopped');

  // Close task queue (drains in-flight jobs)
  await shutdownTaskQueue();
  await shutdownShowQueue();
  await shutdownContainerPool();
  log.general.info('Task queues shut down');
}
