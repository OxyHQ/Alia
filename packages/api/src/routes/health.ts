import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { getAllProviderHealth, type HealthMetrics } from '../lib/gateway-client.js';
import { isQueueActive } from '../lib/task-queue.js';
import { log } from '../lib/logger.js';

/**
 * Liveness, readiness and the detailed snapshot.
 *
 * ## Readiness asks the DATABASE, not the driver
 *
 * The previous version read `mongoose.connection.readyState`, which is the
 * driver's opinion of its own socket. This issues a real statement against the
 * store the service actually reads, so a pool that is connected but cannot serve
 * — exhausted, or pointed at a database the role cannot open — reports not-ready
 * instead of ready. A connection flag cannot distinguish those.
 *
 * ## `/live` is deliberately unconditional, and that is a trap worth naming
 *
 * `/live` answers "is this process running", so it must not consult a
 * dependency: a liveness probe that fails on a database blip gets the task
 * KILLED and replaced, which is the worst possible response to the database
 * being briefly unavailable. Readiness is the probe that removes a task from
 * rotation.
 *
 * The trap is that the two are easy to point at the wrong way round. As of this
 * change the `oxy-alia` target group health-checks `/health/live`, so a task
 * whose database is unreachable is still marked healthy and still receives
 * traffic — every request then fails behind a green check. Moving the target
 * group to `/health/ready` lives in `oxy-infra` and must happen BEFORE this
 * service is scaled up again.
 *
 * ## Mongo is not reported here any more
 *
 * Mongoose call sites remain until the last domain is ported, but their failure
 * mode is a 500 on the route that made the call, not a health signal — the
 * connection is opened with `bufferCommands: false`, so those calls throw rather
 * than hang. Reporting a connection that can never be established would pin this
 * service to `degraded` forever and make the whole endpoint uninformative.
 */

const router = Router();

// ============== HEALTH STATE CACHE ==============
// Avoid querying providers on every health check

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

async function getHealthSnapshot() {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  const postgresReady = await isPostgresReady();

  let providersSummary = { total: 0, healthy: 0, unhealthy: 0, openCircuits: 0 };
  let providersReachable = false;
  try {
    const providers = await getAllProviderHealth();
    providersReachable = true;
    providersSummary = {
      total: providers.length,
      healthy: providers.filter((p: HealthMetrics) => p.isHealthy).length,
      unhealthy: providers.filter((p: HealthMetrics) => !p.isHealthy).length,
      openCircuits: providers.filter((p: HealthMetrics) => p.circuitState === 'open').length,
    };
  } catch {
    // Gateway unreachable — don't penalize health status
  }

  const mem = process.memoryUsage();
  const redisStatus = isQueueActive() ? 'connected' : 'unavailable';

  // Only require healthy providers if we could actually reach the gateway
  const isHealthy = postgresReady && (!providersReachable || providersSummary.healthy > 0);

  const snapshot = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    postgres: postgresReady ? 'connected' : 'unavailable',
    redis: redisStatus,
    providers: providersSummary,
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

// Readiness probe: Postgres answers a real query + at least 1 provider healthy.
// Used by load balancers to decide if this instance should receive traffic.
router.get('/ready', async (_req, res) => {
  if (!(await isPostgresReady())) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }

  try {
    const providers = await getAllProviderHealth();
    const hasHealthyProvider = providers.some((p: HealthMetrics) => p.isHealthy);
    if (!hasHealthyProvider && providers.length > 0) {
      return res.status(503).json({ status: 'not_ready', reason: 'no_healthy_providers' });
    }
  } catch {
    // If we can't check providers, still consider ready if Postgres is up
  }

  res.status(200).json({ status: 'ready' });
});

export default router;
