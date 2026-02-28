import { Request, Response, NextFunction } from 'express';
import ApiKeyUsage from '../models/api-key-usage';
import DeveloperApiKey, { IRateLimitConfig } from '../models/developer-api-key';
import { Subscription } from '../models/subscription';
import mongoose from 'mongoose';
import { checkLimit } from '../lib/sliding-window-limiter.js';
import { log } from '../lib/logger.js';

interface RateLimitStatus {
  limited: boolean;
  limitType?: 'requestsPerMinute' | 'requestsPerDay' | 'tokensPerMinute' | 'tokensPerDay';
  current?: number;
  limit?: number;
  resetInSeconds?: number;
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
  const subscription = await Subscription.findOne({
    oxyUserId: userId,
    status: { $in: ['active', 'trialing'] },
  }).sort({ createdAt: -1 });

  if (!subscription) {
    return 'free';
  }

  const planName = subscription.plan?.name?.toLowerCase() || '';

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

// ── In-memory sliding window for API key rate limiting ──
// Replaces per-request MongoDB countDocuments with O(1) in-memory checks.
// Same approach as session-based rate limiting (sliding-window-limiter.ts).

interface ApiKeyWindow {
  timestamps: number[];
  dailyRequests: number;
  lastResetDay: number;
}

const apiKeyWindows = new Map<string, ApiKeyWindow>();
const MAX_API_KEY_ENTRIES = 10_000;

function getDayOfYear(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

function getOrCreateApiKeyWindow(apiKeyId: string): ApiKeyWindow {
  let state = apiKeyWindows.get(apiKeyId);
  if (!state) {
    if (apiKeyWindows.size >= MAX_API_KEY_ENTRIES) {
      const firstKey = apiKeyWindows.keys().next().value;
      if (firstKey !== undefined) apiKeyWindows.delete(firstKey);
    }
    state = { timestamps: [], dailyRequests: 0, lastResetDay: getDayOfYear() };
    apiKeyWindows.set(apiKeyId, state);
  }
  const today = getDayOfYear();
  if (state.lastResetDay !== today) {
    state.dailyRequests = 0;
    state.lastResetDay = today;
  }
  return state;
}

/**
 * Check if an API key has exceeded its rate limits (in-memory, sub-microsecond).
 * Replaces the previous MongoDB countDocuments approach that ran O(n) DB queries per request.
 */
function checkApiKeyRateLimits(
  apiKeyId: string,
  rateLimit: IRateLimitConfig
): RateLimitStatus {
  const state = getOrCreateApiKeyWindow(apiKeyId);
  const now = Date.now();
  const windowMs = 60_000;

  // Prune timestamps older than 1 minute
  state.timestamps = state.timestamps.filter(t => now - t < windowMs);

  // Check requests per minute
  if (rateLimit.requestsPerMinute !== null && state.timestamps.length >= rateLimit.requestsPerMinute) {
    const oldestInWindow = state.timestamps[0];
    const resetInSeconds = Math.ceil((oldestInWindow + windowMs - now) / 1000);
    return {
      limited: true,
      limitType: 'requestsPerMinute',
      current: state.timestamps.length,
      limit: rateLimit.requestsPerMinute,
      resetInSeconds: Math.max(resetInSeconds, 1),
    };
  }

  // Check requests per day
  if (rateLimit.requestsPerDay !== null && state.dailyRequests >= rateLimit.requestsPerDay) {
    const now_ = new Date();
    const midnight = new Date(now_.getFullYear(), now_.getMonth(), now_.getDate() + 1);
    const resetInSeconds = Math.ceil((midnight.getTime() - now_.getTime()) / 1000);
    return {
      limited: true,
      limitType: 'requestsPerDay',
      current: state.dailyRequests,
      limit: rateLimit.requestsPerDay,
      resetInSeconds: Math.max(resetInSeconds, 60),
    };
  }

  // Record the request
  state.timestamps.push(now);
  state.dailyRequests++;

  return { limited: false };
}

/**
 * Rate limiting middleware for Developer API Keys
 * Must be used AFTER authenticateApiKey or authenticateTokenOrApiKey middleware
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

  // Handle API key rate limiting
  if (req.apiKey) {
    try {
      const apiKey = await DeveloperApiKey.findById(req.apiKey.id).select('rateLimit');

      if (!apiKey) {
        res.status(401).json({ error: 'API key not found' });
        return;
      }

      const rateLimit: IRateLimitConfig = apiKey.rateLimit || {
        requestsPerMinute: null,
        requestsPerDay: 1000,
        tokensPerMinute: null,
        tokensPerDay: null,
      };

      const status = checkApiKeyRateLimits(req.apiKey.id, rateLimit);

      if (status.limited) {
        return sendRateLimitResponse(res, status);
      }

      return next();
    } catch (error) {
      log.rateLimit.error({ err: error }, 'API key rate limit check error');
      return next();
    }
  }

  // Handle session-based user rate limiting (in-memory sliding window)
  if (req.user?.id && !req.apiKey) {
    try {
      const tier = await getUserTier(req.user.id);
      const result = checkLimit(req.user.id, tier);

      if (!result.allowed) {
        return sendRateLimitResponse(res, {
          limited: true,
          limitType: result.limitType === 'rpm' ? 'requestsPerMinute' : 'tokensPerDay',
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

  res.status(429).json({
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: `Rate limit exceeded: ${status.current}/${status.limit} ${limitTypeMessages[status.limitType!]}`,
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
 * Get current usage stats for an API key
 */
export async function getApiKeyUsageStats(apiKeyId: string): Promise<{
  requestsLastMinute: number;
  requestsLastDay: number;
  tokensLastMinute: number;
  tokensLastDay: number;
}> {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const keyObjectId = new mongoose.Types.ObjectId(apiKeyId);

  const [requestsLastMinute, requestsLastDay, tokensMinute, tokensDay] = await Promise.all([
    ApiKeyUsage.countDocuments({
      apiKeyId: keyObjectId,
      timestamp: { $gte: oneMinuteAgo },
    }),
    ApiKeyUsage.countDocuments({
      apiKeyId: keyObjectId,
      timestamp: { $gte: oneDayAgo },
    }),
    ApiKeyUsage.aggregate([
      { $match: { apiKeyId: keyObjectId, timestamp: { $gte: oneMinuteAgo } } },
      { $group: { _id: null, total: { $sum: '$tokensUsed' } } },
    ]),
    ApiKeyUsage.aggregate([
      { $match: { apiKeyId: keyObjectId, timestamp: { $gte: oneDayAgo } } },
      { $group: { _id: null, total: { $sum: '$tokensUsed' } } },
    ]),
  ]);

  return {
    requestsLastMinute,
    requestsLastDay,
    tokensLastMinute: tokensMinute[0]?.total || 0,
    tokensLastDay: tokensDay[0]?.total || 0,
  };
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

  const [requestsLastMinute, requestsLastDay, tokensMinute, tokensDay, tier] = await Promise.all([
    ApiKeyUsage.countDocuments({
      oxyUserId: userId,
      authType: 'session',
      timestamp: { $gte: oneMinuteAgo },
    }),
    ApiKeyUsage.countDocuments({
      oxyUserId: userId,
      authType: 'session',
      timestamp: { $gte: oneDayAgo },
    }),
    ApiKeyUsage.aggregate([
      { $match: { oxyUserId: userId, authType: 'session', timestamp: { $gte: oneMinuteAgo } } },
      { $group: { _id: null, total: { $sum: '$tokensUsed' } } },
    ]),
    ApiKeyUsage.aggregate([
      { $match: { oxyUserId: userId, authType: 'session', timestamp: { $gte: oneDayAgo } } },
      { $group: { _id: null, total: { $sum: '$tokensUsed' } } },
    ]),
    getUserTier(userId),
  ]);

  return {
    requestsLastMinute,
    requestsLastDay,
    tokensLastMinute: tokensMinute[0]?.total || 0,
    tokensLastDay: tokensDay[0]?.total || 0,
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
    const usageRecord: any = {
      oxyUserId: req.user?.id || req.userId,
      endpoint: req.path,
      method: req.method,
      statusCode,
      tokensUsed: tokensUsed || 0,
      creditsUsed: creditsUsed || 0,
      responseTime,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip || req.socket?.remoteAddress,
      timestamp: new Date(),
    };

    if (req.serviceApp) {
      usageRecord.authType = 'internal';
      usageRecord.serviceApp = req.serviceApp.appName;
    } else if (req.apiKey) {
      usageRecord.apiKeyId = req.apiKey.id;
      usageRecord.appId = req.apiKey.appId;
      usageRecord.authType = 'api_key';
    } else {
      usageRecord.authType = 'session';
    }

    // Mark that usage was explicitly recorded, so the auth middleware skips its own logging
    (req as any)._usageRecorded = true;

    await ApiKeyUsage.create(usageRecord);
  } catch (error) {
    log.rateLimit.error({ err: error }, 'Failed to record usage');
  }
}
