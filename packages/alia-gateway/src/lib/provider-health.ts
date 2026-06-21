/**
 * Provider Health Monitoring System
 *
 * Tracks provider reliability, implements circuit breaker pattern,
 * and automatically adjusts routing based on real-time health metrics.
 */

import { connectDB } from './db';
import mongoose from 'mongoose';
import { log } from './logger';

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

// Circuit breaker configuration
const CIRCUIT_CONFIG = {
  failureThreshold: 5,              // Open circuit after 5 consecutive failures
  successThreshold: 2,              // Close circuit after 2 consecutive successes in half-open
  openDurationMs: 60000,            // Keep circuit open for 1 minute
  halfOpenMaxAttempts: 3,           // Try 3 requests in half-open state
  minRequestsForMetrics: 10,        // Need 10 requests before calculating success rate
  unhealthySuccessRateThreshold: 50 // Consider unhealthy if success rate < 50%
};

// ============== MONGODB SCHEMA ==============

const ProviderHealthSchema = new mongoose.Schema({
  provider: { type: String, required: true, index: true },
  modelId: { type: String, required: true, index: true },
  successCount: { type: Number, default: 0 },
  failureCount: { type: Number, default: 0 },
  totalRequests: { type: Number, default: 0 },
  successRate: { type: Number, default: 100 },
  averageLatencyMs: { type: Number, default: 0 },
  latencySamples: { type: [Number], default: [] }, // Last 100 samples
  lastSuccess: { type: Date, default: null },
  lastFailure: { type: Date, default: null },
  consecutiveFailures: { type: Number, default: 0 },
  consecutiveSuccesses: { type: Number, default: 0 },
  circuitState: { type: String, enum: ['closed', 'open', 'half-open'], default: 'closed' },
  circuitOpenedAt: { type: Date, default: null },
  halfOpenAttempts: { type: Number, default: 0 },
  lastHealthCheck: { type: Date, default: Date.now },
  isHealthy: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Compound index for unique provider+model combination
ProviderHealthSchema.index({ provider: 1, modelId: 1 }, { unique: true });

const ProviderHealth = mongoose.models.ProviderHealth || mongoose.model('ProviderHealth', ProviderHealthSchema);

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
    await connectDB();
    let health = await ProviderHealth.findOne({ provider, modelId });

    if (!health) {
      // Initialize new health record
      health = await ProviderHealth.create({
        provider,
        modelId,
        successCount: 0,
        failureCount: 0,
        totalRequests: 0,
        successRate: 100,
        averageLatencyMs: 0,
        latencySamples: [],
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        circuitState: 'closed',
        isHealthy: true,
        lastHealthCheck: new Date()
      });
    }

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
 * Record a successful request
 */
export async function recordSuccess(
  provider: string,
  modelId: string,
  latencyMs: number
): Promise<void> {
  try {
    await connectDB();
    const health = await ProviderHealth.findOne({ provider, modelId });

    if (!health) {
      // Create new record with success
      await ProviderHealth.create({
        provider,
        modelId,
        successCount: 1,
        failureCount: 0,
        totalRequests: 1,
        successRate: 100,
        averageLatencyMs: latencyMs,
        latencySamples: [latencyMs],
        lastSuccess: new Date(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
        circuitState: 'closed',
        isHealthy: true
      });
    } else {
      // Update existing record
      health.successCount++;
      health.totalRequests++;
      health.lastSuccess = new Date();
      health.consecutiveFailures = 0;
      health.consecutiveSuccesses++;

      // Update latency (keep last 100 samples)
      if (!health.latencySamples) health.latencySamples = [];
      health.latencySamples.push(latencyMs);
      if (health.latencySamples.length > 100) {
        health.latencySamples = health.latencySamples.slice(-100);
      }
      health.averageLatencyMs = health.latencySamples.reduce((a: any, b: any) => a + b, 0) / health.latencySamples.length;

      // Update success rate
      health.successRate = (health.successCount / health.totalRequests) * 100;

      // Circuit breaker logic
      if (health.circuitState === 'half-open') {
        health.halfOpenAttempts++;
        if (health.consecutiveSuccesses >= CIRCUIT_CONFIG.successThreshold) {
          // Close the circuit - provider is healthy again
          health.circuitState = 'closed';
          health.circuitOpenedAt = null;
          health.halfOpenAttempts = 0;
          health.isHealthy = true;
        }
      }

      // Check overall health
      if (health.totalRequests >= CIRCUIT_CONFIG.minRequestsForMetrics) {
        health.isHealthy = health.successRate >= CIRCUIT_CONFIG.unhealthySuccessRateThreshold;
      }

      health.lastHealthCheck = new Date();
      await health.save();
    }

    // Invalidate cache
    healthCache.delete(getCacheKey(provider, modelId));
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
    await connectDB();
    const health = await ProviderHealth.findOne({ provider, modelId });

    if (!health) {
      // Create new record with failure
      await ProviderHealth.create({
        provider,
        modelId,
        successCount: 0,
        failureCount: 1,
        totalRequests: 1,
        successRate: 0,
        lastFailure: new Date(),
        consecutiveFailures: isRateLimit ? 0 : 1,
        consecutiveSuccesses: 0,
        circuitState: 'closed',
        isHealthy: true // Still healthy after single failure
      });
    } else {
      // Update existing record
      health.failureCount++;
      health.totalRequests++;
      health.lastFailure = new Date();

      if (!isRateLimit) {
        // Only real failures (500s, timeouts, auth errors) affect circuit breaker
        health.consecutiveFailures++;
        health.consecutiveSuccesses = 0;
      }

      // Update success rate
      health.successRate = (health.successCount / health.totalRequests) * 100;

      // Circuit breaker logic
      if (health.circuitState === 'closed') {
        if (health.consecutiveFailures >= CIRCUIT_CONFIG.failureThreshold) {
          // Open the circuit - stop sending requests
          health.circuitState = 'open';
          health.circuitOpenedAt = new Date();
          health.isHealthy = false;
        }
      } else if (health.circuitState === 'half-open') {
        // Failed in half-open state - re-open circuit
        health.circuitState = 'open';
        health.circuitOpenedAt = new Date();
        health.halfOpenAttempts = 0;
        health.isHealthy = false;
      }

      // Check overall health
      if (health.totalRequests >= CIRCUIT_CONFIG.minRequestsForMetrics) {
        health.isHealthy = health.successRate >= CIRCUIT_CONFIG.unhealthySuccessRateThreshold;
      }

      health.lastHealthCheck = new Date();
      await health.save();
    }

    // Invalidate cache
    healthCache.delete(getCacheKey(provider, modelId));
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
    // Check if we should transition to half-open
    if (health.lastFailure) {
      const timeSinceOpen = Date.now() - health.lastFailure.getTime();
      if (timeSinceOpen >= CIRCUIT_CONFIG.openDurationMs) {
        // Transition to half-open - try again
        try {
          await connectDB();
          await ProviderHealth.updateOne(
            { provider, modelId },
            {
              circuitState: 'half-open',
              halfOpenAttempts: 0,
              consecutiveSuccesses: 0
            }
          );
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
    await connectDB();
    const healthRecords = await ProviderHealth.find({}).sort({ updatedAt: -1 });
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
    await connectDB();
    await ProviderHealth.findOneAndUpdate(
      { provider, modelId },
      {
        successCount: 0,
        failureCount: 0,
        totalRequests: 0,
        successRate: 100,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        circuitState: 'closed',
        circuitOpenedAt: null,
        halfOpenAttempts: 0,
        isHealthy: true,
        lastHealthCheck: new Date()
      },
      { upsert: true }
    );
    healthCache.delete(getCacheKey(provider, modelId));
  } catch (error) {
    log.providers.error({ err: error }, 'Error resetting health');
  }
}

// ============== HELPER FUNCTIONS ==============

function healthToMetrics(health: any): HealthMetrics {
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
    lastHealthCheck: health.lastHealthCheck,
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
      await connectDB();
      const healths = await ProviderHealth.find({ circuitState: { $in: ['open', 'half-open'] } });

      for (const health of healths) {
        const timeSinceLastCheck = Date.now() - health.lastHealthCheck.getTime();

        // Auto-transition open circuits to half-open after cooldown
        if (health.circuitState === 'open' && health.circuitOpenedAt) {
          const timeSinceOpen = Date.now() - health.circuitOpenedAt.getTime();
          if (timeSinceOpen >= CIRCUIT_CONFIG.openDurationMs) {
            health.circuitState = 'half-open';
            health.halfOpenAttempts = 0;
            await health.save();
          }
        }
      }
    } catch (error) {
      log.providers.error({ err: error }, 'Error in health check monitor');
    }
  }, 5 * 60 * 1000); // Every 5 minutes
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
