import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { unsetOxyInferenceVariables } from '../lib/inference/oxy-inference.js';
import { isQueueActive } from '../lib/task-queue.js';
import { log } from '../lib/logger.js';

/**
 * Liveness, readiness and the detailed dependency snapshot.
 *
 * Liveness is process-only. Readiness executes a real Postgres statement and
 * reports whether the Oxy inference lane is configured without pretending to
 * probe Oxy or Kaana. Kaana owns all hosted-provider runtime
 * state; Alia exposes no provider-key census or provider-specific readiness.
 */

const router = Router();

// ============== HEALTH STATE CACHE ==============
// Avoid repeating dependency probes on every health check.

let healthCache: { data: unknown; expiry: number } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000; // 10 seconds

/**
 * One real statement against Postgres.
 *
 * Returns a boolean rather than throwing, because both callers want to REPORT
 * the failure rather than propagate it. `getDb()` throwing (Postgres never
 * connected) and the query failing (connected, but not usable) are the same
 * answer to the only question being asked.
 */
async function isPostgresReady(): Promise<boolean> {
  try {
    await getDb().execute(sql`select 1`);
    return true;
  } catch (err) {
    log.general.warn({ err }, 'Health: Postgres probe failed');
    return false;
  }
}

/**
 * Everything this process knows about its Kaana path, under ONE compatibility name.
 *
 * `credentials` says only whether this process has what it needs to authenticate
 * to Oxy. `configured` is not `serving`: nothing is probed to answer it.
 */
function kaanaReport(): {
  readonly path: 'oxy';
  readonly credentials: 'configured' | 'not_configured';
} {
  return {
    path: 'oxy',
    credentials: unsetOxyInferenceVariables().length === 0 ? 'configured' : 'not_configured',
  };
}

async function getHealthSnapshot() {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  const postgresReady = await isPostgresReady();

  const mem = process.memoryUsage();
  const redisStatus = isQueueActive() ? 'connected' : 'unavailable';
  const kaana = kaanaReport();

  const isHealthy = postgresReady;

  const snapshot = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    postgres: postgresReady ? 'connected' : 'unavailable',
    redis: redisStatus,
    kaana,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),       // MB
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024), // MB
    },
  };

  healthCache = { data: snapshot, expiry: Date.now() + HEALTH_CACHE_TTL_MS };
  return snapshot;
}

// Full health check with details
router.get('/', async (_req, res) => {
  try {
    const snapshot = await getHealthSnapshot() as { status: string };
    const statusCode = snapshot.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(snapshot);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Health check failed');
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  }
});

// Liveness probe: process is running -> 200. Consults NOTHING; see the module comment.
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness probe: can THIS TASK serve the API. One condition — Postgres
// answers a real query through this task's own pool. Used by load balancers to
// decide if this instance should receive traffic.
router.get('/ready', async (_req, res) => {
  if (!(await isPostgresReady())) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }

  // Neither provider state nor Kaana is consulted. Both are reported — Kaana
  // right here in the body — and neither may deregister a task. See the module
  // comment for the test that decides which conditions belong in this answer.
  res.status(200).json({ status: 'ready', kaana: kaanaReport() });
});

export default router;
