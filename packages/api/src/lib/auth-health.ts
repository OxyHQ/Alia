/**
 * Auth Health Monitoring
 *
 * Tracks authentication success/failure rates per method in hourly buckets. All
 * recording functions are fire-and-forget safe — they never throw or block the
 * auth flow.
 *
 * This module is the ONLY thing that touches `auth_health_metrics`. Its two
 * consumers (`internal/providers/middleware/auth.ts`,
 * `internal/providers/routes/auth-health.ts`) call these three functions and
 * have never seen the model, which is why moving the store underneath changed
 * nothing outside this file. The statements live in
 * `db/telemetry/authHealthRepository.ts`.
 */

import {
  bucketedHour,
  incrementAuthFailure,
  incrementAuthSuccess,
  summariseAuthHealth,
} from '../db/telemetry/authHealthRepository.js';
import { getDb } from '../db/index.js';

// --- Types ---

export type AuthMethod = 'jwt' | 'api_key' | 'telegram' | 'service';

export interface AuthHealthSummary {
  method: string;
  totalSuccesses: number;
  totalFailures: number;
  successRate: number;
  lastFailure: Date | null;
  lastFailureReason: string | null;
  isHealthy: boolean;
}

// --- Public API ---

/**
 * Record an auth success for the given method.
 * Fire-and-forget safe: never throws.
 */
export async function recordAuthSuccess(method: string): Promise<void> {
  try {
    await incrementAuthSuccess(getDb(), method, bucketedHour());
  } catch {
    // Silently ignore — recording must never impact the auth flow
  }
}

/**
 * Record an auth failure for the given method.
 * Fire-and-forget safe: never throws.
 */
export async function recordAuthFailure(method: string, reason?: string): Promise<void> {
  try {
    await incrementAuthFailure(
      getDb(),
      method,
      bucketedHour(),
      new Date(),
      reason?.substring(0, 500),
    );
  } catch {
    // Silently ignore — recording must never impact the auth flow
  }
}

/**
 * Get aggregated auth health stats for the last N hours (default 24).
 * Used by the admin dashboard endpoint.
 */
export async function getAuthHealthStats(hours: number = 24): Promise<AuthHealthSummary[]> {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  const groups = await summariseAuthHealth(getDb(), since);

  return groups.map((g) => {
    const total = g.totalSuccesses + g.totalFailures;
    // No traffic reads as healthy, not as a 0% success rate.
    const successRate = total > 0 ? g.totalSuccesses / total : 1;
    // Healthy if failure rate < 20% OR less than 10 total requests
    const isHealthy = total < 10 || successRate >= 0.8;

    return {
      method: g.method,
      totalSuccesses: g.totalSuccesses,
      totalFailures: g.totalFailures,
      successRate: Math.round(successRate * 10000) / 10000, // 4 decimal places
      lastFailure: g.lastFailure,
      lastFailureReason: g.lastFailureReason,
      isHealthy,
    };
  });
}
