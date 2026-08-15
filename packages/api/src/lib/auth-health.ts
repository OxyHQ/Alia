/**
 * Auth Health Monitoring
 *
 * Tracks authentication success/failure rates per method in hourly buckets. All
 * recording functions are fire-and-forget safe — they never throw or block the
 * auth flow.
 *
 * This module is the ONLY thing that touches `auth_health_metrics`, through
 * `db/telemetry/authHealthRepository.ts` — nothing above it has ever seen the
 * model, which is why moving the store underneath changed nothing outside this
 * file.
 *
 * It currently has NO CALLERS. Its only two were the HMAC service middleware
 * and the stats route of the `/internal/gateway` admin surface, and both were
 * unreachable — no `app.use` ever mounted that router — for as long as they
 * existed, so this table has never been written in production. They were
 * deleted with the rest of that surface.
 *
 * The table is still registered as an expiry target (`db/expiryTargets.ts`) and
 * is still swept. Two live options, neither of which is this file's to pick:
 * call `recordAuthSuccess`/`recordAuthFailure` from the real auth middleware
 * (`middleware/auth.ts`), which would make the metrics mean something for the
 * first time; or retire the table, its repository and its expiry entry
 * together.
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
