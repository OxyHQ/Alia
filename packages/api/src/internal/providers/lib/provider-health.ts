/**
 * Provider Health Monitoring System
 *
 * Tracks provider reliability, implements the circuit breaker pattern, and
 * gates routing on real-time health.
 *
 * This module is the ONLY thing that touches `provider_health`. Every consumer
 * — the fallback engine, the model registry, the gateway client, the providers
 * routes — imports these functions and has never seen the model, which is why
 * moving the store underneath changes nothing outside this file. The statements
 * live in `db/telemetry/providerHealthRepository.ts`.
 *
 * Two callers did NOT come through here: they reached the collection as
 * `mongoose.models.ProviderHealth`, bypassing the chokepoint entirely. Both now
 * call this module's {@link resetAllCircuitBreakers} and
 * {@link resetAllProviderHealth}, so the chokepoint is real rather than merely
 * conventional.
 */

import {
  CIRCUIT_CONFIG,
  closeAllCircuits,
  getOrCreateProviderHealth,
  halfOpenExpiredCircuits,
  listProviderHealth,
  openCircuitForProbe,
  recordProviderFailure,
  recordProviderSuccess,
  resetAllProviderHealth as resetAllRows,
  resetProviderHealth as resetRow,
  type ProviderHealthRow,
} from '../../../db/telemetry/providerHealthRepository.js';
import { getDb } from '../../../db/index.js';
import { log } from '../../../lib/logger.js';

// ============== HEALTH METRICS ==============

export interface HealthMetrics {
  provider: string;
  modelId: string;
  successCount: number;
  failureCount: number;
  totalRequests: number;
  successRate: number;              // 0-100
  averageLatencyMs: number;
  lastSuccess: Date | null;
  lastFailure: Date | null;
  consecutiveFailures: number;
  circuitState: 'closed' | 'open' | 'half-open';
  lastHealthCheck: Date;
  isHealthy: boolean;
}

// ============== IN-MEMORY CACHE ==============

// Cache health data for fast lookups (TTL: 10 seconds)
const healthCache = new Map<string, { metrics: HealthMetrics; expiry: number }>();
const CACHE_TTL_MS = 10000;

function getCacheKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function getCachedHealth(provider: string, modelId: string): HealthMetrics | null {
  const key = getCacheKey(provider, modelId);
  const cached = healthCache.get(key);
  if (cached && cached.expiry > Date.now()) {
    return cached.metrics;
  }
  healthCache.delete(key);
  return null;
}

function setCachedHealth(provider: string, modelId: string, metrics: HealthMetrics): void {
  const key = getCacheKey(provider, modelId);
  healthCache.set(key, {
    metrics,
    expiry: Date.now() + CACHE_TTL_MS
  });
}

/**
 * Clear the entire in-memory health cache (used during config reload)
 */
export function clearHealthCache(): void {
  healthCache.clear();
}

// ============== HEALTH MONITORING API ==============

/**
 * Get health metrics for a provider/model combination
 */
export async function getProviderHealth(provider: string, modelId: string): Promise<HealthMetrics> {
  // Check cache first
  const cached = getCachedHealth(provider, modelId);
  if (cached) {
    return cached;
  }

  try {
    const health = await getOrCreateProviderHealth(getDb(), provider, modelId, new Date());
    const metrics = healthToMetrics(health);
    setCachedHealth(provider, modelId, metrics);
    return metrics;
  } catch (error) {
    log.providers.error({ err: error, provider, modelId }, 'Error fetching health');
    // Return default healthy state on error
    return {
      provider,
      modelId,
      successCount: 0,
      failureCount: 0,
      totalRequests: 0,
      successRate: 100,
      averageLatencyMs: 1500,
      lastSuccess: null,
      lastFailure: null,
      consecutiveFailures: 0,
      circuitState: 'closed',
      lastHealthCheck: new Date(),
      isHealthy: true
    };
  }
}

/**
 * Record a successful request.
 *
 * The counters and the circuit state they imply move in ONE statement — see the
 * repository for why that is a deliberate improvement on the two writes this
 * replaced.
 */
export async function recordSuccess(
  provider: string,
  modelId: string,
  latencyMs: number
): Promise<void> {
  try {
    const transition = await recordProviderSuccess(getDb(), provider, modelId, latencyMs, new Date());
    // Only invalidate the availability cache when routing-relevant state changed.
    if (transition.nextState !== transition.prevState || transition.nextHealthy !== transition.prevHealthy) {
      healthCache.delete(getCacheKey(provider, modelId));
    }
  } catch (error) {
    log.providers.error({ err: error }, 'Error recording success');
  }
}

/**
 * Record a failed request
 */
export async function recordFailure(
  provider: string,
  modelId: string,
  errorCode?: string
): Promise<void> {
  // Rate limits are transient (provider works fine, just hit quota).
  // They should NOT increment consecutiveFailures or open the circuit breaker.
  const isRateLimit = errorCode != null && /rate.?limit|429|RESOURCE_EXHAUSTED|quota/i.test(errorCode);

  try {
    const transition = await recordProviderFailure(getDb(), provider, modelId, new Date(), isRateLimit);
    // Only invalidate the availability cache when routing-relevant state changed.
    if (transition.nextState !== transition.prevState || transition.nextHealthy !== transition.prevHealthy) {
      healthCache.delete(getCacheKey(provider, modelId));
    }
  } catch (error) {
    log.providers.error({ err: error }, 'Error recording failure');
  }
}

/**
 * Check if a provider should accept requests (circuit breaker check)
 */
export async function isProviderAvailable(provider: string, modelId: string): Promise<boolean> {
  const health = await getProviderHealth(provider, modelId);

  if (health.circuitState === 'closed') {
    return true; // Circuit closed - provider is healthy
  }

  if (health.circuitState === 'open') {
    // Check if we should transition to half-open.
    //
    // The cooldown is measured from `lastFailure` here and from `circuitOpenedAt`
    // in the background monitor. That divergence predates the port and is kept:
    // they answer different questions, and unifying them would change routing.
    if (health.lastFailure) {
      const timeSinceOpen = Date.now() - health.lastFailure.getTime();
      if (timeSinceOpen >= CIRCUIT_CONFIG.openDurationMs) {
        // Transition to half-open - try again
        try {
          await openCircuitForProbe(getDb(), provider, modelId);
          healthCache.delete(getCacheKey(provider, modelId));
          return true;
        } catch (error) {
          log.providers.error({ err: error, provider, modelId }, 'Error transitioning to half-open');
          return false;
        }
      }
    }
    return false; // Circuit still open
  }

  if (health.circuitState === 'half-open') {
    // In half-open state, allow limited requests
    return true;
  }

  return true;
}

/**
 * Get all provider health metrics (for monitoring dashboard)
 */
export async function getAllProviderHealth(): Promise<HealthMetrics[]> {
  try {
    const healthRecords = await listProviderHealth(getDb());
    return healthRecords.map(healthToMetrics);
  } catch (error) {
    log.providers.error({ err: error }, 'Error fetching all health metrics');
    return [];
  }
}

/**
 * Reset health metrics for a provider (admin function)
 */
export async function resetProviderHealth(provider: string, modelId: string): Promise<void> {
  try {
    await resetRow(getDb(), provider, modelId, new Date());
    healthCache.delete(getCacheKey(provider, modelId));
  } catch (error) {
    log.providers.error({ err: error }, 'Error resetting health');
  }
}

/**
 * Close every circuit that is currently open or half-open, leaving traffic
 * counters intact. Run after a deploy so a stale lockout does not survive it.
 *
 * Returns the number of circuits closed.
 *
 * Previously reached through `mongoose.models.ProviderHealth`, which returned 0
 * and logged "model not loaded yet" when the model had not been registered. That
 * branch is gone: it existed only because Mongoose registers models lazily on
 * first import, and Postgres is connected before the service listens. The reset
 * now always runs, which is what the caller always intended.
 */
export async function resetAllCircuitBreakers(): Promise<number> {
  const closed = await closeAllCircuits(getDb(), new Date());
  clearHealthCache();
  return closed;
}

/**
 * Return EVERY provider/model row to its default state, counters included.
 *
 * The operator hammer behind `POST /v1/providers/health/reset-all`, and
 * deliberately NOT the same thing as {@link resetAllCircuitBreakers} — this one
 * erases the success history as well.
 */
export async function resetAllProviderHealth(): Promise<number> {
  const reset = await resetAllRows(getDb(), new Date());
  clearHealthCache();
  return reset;
}

// ============== HELPER FUNCTIONS ==============

function healthToMetrics(health: ProviderHealthRow): HealthMetrics {
  return {
    provider: health.provider,
    modelId: health.modelId,
    successCount: health.successCount,
    failureCount: health.failureCount,
    totalRequests: health.totalRequests,
    successRate: health.successRate,
    averageLatencyMs: health.averageLatencyMs || 0,
    lastSuccess: health.lastSuccess,
    lastFailure: health.lastFailure,
    consecutiveFailures: health.consecutiveFailures,
    circuitState: health.circuitState,
    // Nullable in the schema and non-null here: every write path sets it, and a
    // row that somehow lacks one is reported as checked now rather than as a
    // null the dashboard would render as "never".
    lastHealthCheck: health.lastHealthCheck ?? new Date(),
    isHealthy: health.isHealthy
  };
}

// ============== BACKGROUND HEALTH CHECK ==============

// Run periodic health check every 5 minutes
let healthCheckInterval: NodeJS.Timeout | null = null;

export function startHealthCheckMonitor(): void {
  if (healthCheckInterval) return; // Already running

  healthCheckInterval = setInterval(async () => {
    try {
      // One statement, where the Mongo version read every open and half-open row
      // and tested the cooldown per document in JavaScript. Same predicate, no
      // window in which a row can change between the read and the save.
      await halfOpenExpiredCircuits(getDb(), new Date());
    } catch (error) {
      log.providers.error({ err: error }, 'Error in health check monitor');
    }
  }, 5 * 60 * 1000); // Every 5 minutes
  healthCheckInterval.unref?.();
}

export function stopHealthCheckMonitor(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

// Auto-start monitor
if (process.env.NODE_ENV !== 'test') {
  startHealthCheckMonitor();
}
