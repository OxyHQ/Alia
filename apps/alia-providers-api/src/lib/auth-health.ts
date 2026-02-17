/**
 * Auth Health Monitoring
 * Tracks authentication success/failure rates per method using MongoDB atomic operations.
 * All recording functions are fire-and-forget safe — they never throw or block the auth flow.
 */

import mongoose, { Document, Schema, Model } from 'mongoose';

// --- Types ---

export type AuthMethod = 'jwt' | 'api_key' | 'telegram' | 'service';

export interface IAuthHealthMetric extends Document {
  method: string;
  hour: Date;
  successes: number;
  failures: number;
  lastFailure: Date | null;
  lastFailureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthHealthSummary {
  method: string;
  totalSuccesses: number;
  totalFailures: number;
  successRate: number;
  lastFailure: Date | null;
  lastFailureReason: string | null;
  isHealthy: boolean;
}

// --- Schema ---

const AuthHealthMetricSchema = new Schema<IAuthHealthMetric>(
  {
    method: { type: String, required: true, index: true },
    hour: { type: Date, required: true, index: true },
    successes: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    lastFailure: { type: Date, default: null },
    lastFailureReason: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// Compound index for unique method+hour buckets
AuthHealthMetricSchema.index({ method: 1, hour: 1 }, { unique: true });
// TTL index to auto-delete records older than 7 days
AuthHealthMetricSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const AuthHealthMetric: Model<IAuthHealthMetric> =
  mongoose.models.AuthHealthMetric ||
  mongoose.model<IAuthHealthMetric>('AuthHealthMetric', AuthHealthMetricSchema);

// --- Helpers ---

/**
 * Get the current hour bucket (floor to the start of the hour).
 */
function getBucketedHour(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
}

// --- Public API ---

/**
 * Record an auth success for the given method.
 * Fire-and-forget safe: never throws.
 */
export async function recordAuthSuccess(method: string): Promise<void> {
  try {
    const hour = getBucketedHour();
    await AuthHealthMetric.updateOne(
      { method, hour },
      { $inc: { successes: 1 } },
      { upsert: true }
    );
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
    const hour = getBucketedHour();
    const now = new Date();
    await AuthHealthMetric.updateOne(
      { method, hour },
      {
        $inc: { failures: 1 },
        $set: {
          lastFailure: now,
          ...(reason ? { lastFailureReason: reason.substring(0, 500) } : {}),
        },
      },
      { upsert: true }
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

  const results = await AuthHealthMetric.aggregate([
    { $match: { hour: { $gte: since } } },
    {
      $group: {
        _id: '$method',
        totalSuccesses: { $sum: '$successes' },
        totalFailures: { $sum: '$failures' },
        lastFailure: { $max: '$lastFailure' },
        lastFailureReason: { $last: '$lastFailureReason' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return results.map((r) => {
    const total = r.totalSuccesses + r.totalFailures;
    const successRate = total > 0 ? r.totalSuccesses / total : 1;
    // Healthy if failure rate < 20% OR less than 10 total requests
    const isHealthy = total < 10 || successRate >= 0.8;

    return {
      method: r._id,
      totalSuccesses: r.totalSuccesses,
      totalFailures: r.totalFailures,
      successRate: Math.round(successRate * 10000) / 10000, // 4 decimal places
      lastFailure: r.lastFailure || null,
      lastFailureReason: r.lastFailureReason || null,
      isHealthy,
    };
  });
}

export { AuthHealthMetric };
