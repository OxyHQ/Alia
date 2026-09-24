import { Request, Response, NextFunction } from 'express';
import { recordApiKeyUsage, usageWindow } from '../db/telemetry/apiKeyUsageRepository.js';
import { API_KEY_USAGE_METHODS, type ApiKeyUsageMethod } from '../domain/api-key-usage.js';
import { getDb } from '../db/index.js';
import { findActiveSubscription } from '../db/billing/subscriptionRepository.js';
import { checkLimit } from '../lib/sliding-window-limiter.js';
import { log } from '../lib/logger.js';

/**
 * A key's rate-limit allowance. NULL means UNLIMITED, never zero — a zero would
 * read as "no requests permitted", which is the opposite.
 *
 * It lived on the Mongoose model beside the sub-document it described. The
 * sub-document is four columns now, and this is the module that consumes them,
 * so the shape lives here rather than orphaned in a deleted model.
 */
export interface IRateLimitConfig {
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
}

interface RateLimitStatus {
  limited: boolean;
  limitType?: 'requestsPerMinute' | 'requestsPerDay' | 'tokensPerMinute' | 'tokensPerDay';
  current?: number;
  limit?: number;
  resetInSeconds?: number;
}

type UsageAuthType = 'session' | 'internal';

interface UsageRecord {
  oxyUserId: string;
  endpoint: string;
  method: ApiKeyUsageMethod;
  statusCode: number;
  tokensUsed: number;
  creditsUsed: number;
  responseTime?: number;
  userAgent?: string;
  timestamp: Date;
  authType: UsageAuthType;
  serviceApp?: string;
}

// Rate limits by subscription tier for session-based users
// Credits are the sole usage gate — these are burst/abuse protection only (per-minute).
// Daily limits are intentionally null; credits control total usage.
export const TIER_RATE_LIMITS: Record<string, IRateLimitConfig> = {
  free: {
    requestsPerMinute: 20,
    requestsPerDay: null,
    tokensPerMinute: null,
    tokensPerDay: null,
  },
  pro: {
    requestsPerMinute: 60,
    requestsPerDay: null,
    tokensPerMinute: null,
    tokensPerDay: null,
  },
  pro_plus: {
    requestsPerMinute: 120,
    requestsPerDay: null,
    tokensPerMinute: null,
    tokensPerDay: null,
  },
  business: {
    requestsPerMinute: 200,
    requestsPerDay: null,
    tokensPerMinute: null,
    tokensPerDay: null,
  },
  enterprise: {
    requestsPerMinute: null,
    requestsPerDay: null,
    tokensPerMinute: null,
    tokensPerDay: null,
  },
};

/**
 * Get user's subscription tier
 */
export async function getUserTier(userId: string): Promise<string> {
  const subscription = await findActiveSubscription(getDb(), userId);

  if (!subscription) {
    return 'free';
  }

  const planName = subscription.planSnapshotName.toLowerCase();

  if (planName.includes('enterprise')) return 'enterprise';
  if (planName.includes('ultra')) return 'business';
  if (planName.includes('business')) return 'business';
  if (planName.includes('max')) return 'pro_plus';
  if (planName.includes('pro+') || planName.includes('pro plus') || planName.includes('proplus')) return 'pro_plus';
  if (planName.includes('pro')) return 'pro';
  if (planName.includes('go')) return 'pro';

  // Any active subscription defaults to 'pro' tier, not 'free'
  return 'pro';
}

/**
 * Per-user rate limiting for Alia's API surfaces.
 * Must be used AFTER `authenticateTokenOrApiKey` (or another Oxy auth middleware).
 */
export async function apiKeyRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Internal service tokens bypass rate limiting (platform cost)
  if (req.serviceApp) {
    return next();
  }

  // Handle session-based user rate limiting (Redis-backed sliding window)
  if (req.user?.id) {
    try {
      const tier = await getUserTier(req.user.id);
      const result = await checkLimit(req.user.id, tier);

      if (!result.allowed) {
        return sendRateLimitResponse(res, {
          limited: true,
          limitType: 'requestsPerMinute',
          current: result.current,
          limit: result.limit,
          resetInSeconds: result.resetInSeconds,
        }, tier);
      }

      return next();
    } catch (error) {
      log.rateLimit.error({ err: error }, 'User rate limit check error');
      return next();
    }
  }

  // No auth context, skip rate limiting
  next();
}

/**
 * Send rate limit exceeded response
 */
function sendRateLimitResponse(
  res: Response,
  status: RateLimitStatus,
  tier?: string
): void {
  const limitTypeMessages: Record<string, string> = {
    requestsPerMinute: 'requests per minute',
    requestsPerDay: 'requests per day',
    tokensPerMinute: 'tokens per minute',
    tokensPerDay: 'tokens per day',
  };
  const limitLabel = status.limitType ? limitTypeMessages[status.limitType] : 'requests';

  res.status(429).json({
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: `Rate limit exceeded: ${status.current}/${status.limit} ${limitLabel}`,
      retryable: true,
      retryAfter: status.resetInSeconds,
      suggestedAction: tier === 'free' ? 'upgrade' : 'wait',
      details: {
        limitType: status.limitType,
        current: status.current,
        limit: status.limit,
        ...(tier && { tier }),
      },
    },
  });
}

/**
 * Get current usage stats for a session-based user
 */
export async function getUserUsageStats(userId: string): Promise<{
  requestsLastMinute: number;
  requestsLastDay: number;
  tokensLastMinute: number;
  tokensLastDay: number;
  tier: string;
  limits: IRateLimitConfig;
}> {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [minute, day, tier] = await Promise.all([
    usageWindow(getDb(), { oxyUserId: userId, authType: 'session' }, oneMinuteAgo),
    usageWindow(getDb(), { oxyUserId: userId, authType: 'session' }, oneDayAgo),
    getUserTier(userId),
  ]);
  const requestsLastMinute = minute.requests;
  const requestsLastDay = day.requests;

  return {
    requestsLastMinute,
    requestsLastDay,
    tokensLastMinute: minute.tokens,
    tokensLastDay: day.tokens,
    tier,
    limits: TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS.free,
  };
}

/**
 * Record usage for rate limiting tracking
 */
export async function recordUsage(
  req: Request,
  statusCode: number,
  tokensUsed?: number,
  responseTime?: number,
  creditsUsed?: number
): Promise<void> {
  try {
    const oxyUserId = req.user?.id || req.userId;
    if (!oxyUserId) {
      log.rateLimit.warn({ endpoint: req.path, method: req.method }, 'Skipping usage record without auth context');
      return;
    }

    /**
     * `req.method` is any HTTP verb; the column accepts the five this API
     * exposes and a CHECK enforces it. Narrowing against the tuple recognises
     * the mismatch here instead of letting the insert fail in the driver and be
     * logged as "failed to record usage" — which is what happened before, since
     * the Mongoose enum rejected these too. A HEAD or OPTIONS request is now
     * skipped deliberately and says so.
     */
    const method = API_KEY_USAGE_METHODS.find((known) => known === req.method);
    if (!method) {
      log.rateLimit.debug(
        { endpoint: req.path, method: req.method },
        'Not recording usage for a method outside the public API surface',
      );
      return;
    }

    const usageRecord: UsageRecord = {
      oxyUserId,
      endpoint: req.path,
      method,
      statusCode,
      tokensUsed: tokensUsed || 0,
      creditsUsed: creditsUsed || 0,
      responseTime,
      userAgent: req.headers['user-agent'],
      timestamp: new Date(),
      authType: 'session',
    };

    if (req.serviceApp) {
      usageRecord.authType = 'internal';
      usageRecord.serviceApp = req.serviceApp.appName;
    }

    await recordApiKeyUsage(getDb(), usageRecord);
  } catch (error) {
    log.rateLimit.error({ err: error }, 'Failed to record usage');
  }
}
