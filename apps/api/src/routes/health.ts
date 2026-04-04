import { Router } from 'express';
import mongoose from 'mongoose';
import { getAllProviderHealth, type HealthMetrics } from '../lib/gateway-client.js';
import { getRedisClient } from '../lib/redis.js';
import { log } from '../lib/logger.js';

const router = Router();

// ============== HEALTH STATE CACHE ==============
// Avoid querying providers on every health check

let healthCache: { data: any; expiry: number } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000; // 10 seconds

async function getHealthSnapshot() {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  const mongoState = mongoose.connection.readyState;
  const mongoStatus = mongoState === 1 ? 'connected'
    : mongoState === 2 ? 'connecting'
    : mongoState === 3 ? 'disconnecting'
    : 'disconnected';

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
  const redis = getRedisClient();
  const redisStatus = redis ? 'connected' : 'unavailable';

  // Only require healthy providers if we could actually reach the gateway
  const isHealthy = mongoState === 1 && (!providersReachable || providersSummary.healthy > 0);

  const snapshot = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    mongodb: mongoStatus,
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
    const snapshot = await getHealthSnapshot();
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

// Liveness probe: process is running -> 200
// Used by k8s/DO App Platform to detect crashed processes
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness probe: MongoDB connected + at least 1 provider healthy
// Used by load balancers to decide if this instance should receive traffic
router.get('/ready', async (_req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;

  if (!mongoReady) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }

  try {
    const providers = await getAllProviderHealth();
    const hasHealthyProvider = providers.some((p: HealthMetrics) => p.isHealthy);
    if (!hasHealthyProvider && providers.length > 0) {
      return res.status(503).json({ status: 'not_ready', reason: 'no_healthy_providers' });
    }
  } catch {
    // If we can't check providers, still consider ready if MongoDB is up
  }

  res.status(200).json({ status: 'ready' });
});

export default router;
