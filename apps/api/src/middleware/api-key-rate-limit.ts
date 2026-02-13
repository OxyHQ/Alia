import { Request, Response, NextFunction } from 'express';
import ApiKeyUsage from '../models/api-key-usage';
import DeveloperApiKey, { IRateLimitConfig } from '../models/developer-api-key';
import { Subscription } from '../models/subscription';
import mongoose from 'mongoose';

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
async function getUserTier(userId: string): Promise<string> {
  const subscription = await Subscription.findOne({
    oxyUserId: userId,
    status: { $in: ['active', 'trialing'] },
  }).sort({ createdAt: -1 });

  if (!subscription) {
    return 'free';
  }

  const planName = subscription.plan?.name?.toLowerCase() || '';

  if (planName.includes('enterprise')) return 'enterprise';
  if (planName.includes('business')) return 'business';
  if (planName.includes('pro+') || planName.includes('pro plus') || planName.includes('proplus')) return 'pro_plus';
  if (planName.includes('pro')) return 'pro';

  return 'free';
}

/**
 * Check rate limits for session-based users
 */
async function checkUserRateLimits(
  userId: string,
  rateLimit: IRateLimitConfig
): Promise<RateLimitStatus> {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Check requests per minute
  if (rateLimit.requestsPerMinute !== null) {
    const requestsLastMinute = await ApiKeyUsage.countDocuments({
      oxyUserId: userId,
      authType: 'session',
      timestamp: { $gte: oneMinuteAgo },
    });

    if (requestsLastMinute >= rateLimit.requestsPerMinute) {
      return {
        limited: true,
        limitType: 'requestsPerMinute',
        current: requestsLastMinute,
        limit: rateLimit.requestsPerMinute,
        resetInSeconds: 60,
      };
    }
  }

  // Check requests per day
  if (rateLimit.requestsPerDay !== null) {
    const requestsLastDay = await ApiKeyUsage.countDocuments({
      oxyUserId: userId,
      authType: 'session',
      timestamp: { $gte: oneDayAgo },
    });

    if (requestsLastDay >= rateLimit.requestsPerDay) {
      const endOfWindow = new Date(oneDayAgo.getTime() + 24 * 60 * 60 * 1000);
      const resetInSeconds = Math.ceil((endOfWindow.getTime() - now.getTime()) / 1000);

      return {
        limited: true,
        limitType: 'requestsPerDay',
        current: requestsLastDay,
        limit: rateLimit.requestsPerDay,
        resetInSeconds: Math.max(resetInSeconds, 60),
      };
    }
  }

  // Check tokens per minute
  if (rateLimit.tokensPerMinute !== null) {
    const tokensResult = await ApiKeyUsage.aggregate([
      {
        $match: {
          oxyUserId: userId,
          authType: 'session',
          timestamp: { $gte: oneMinuteAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalTokens: { $sum: '$tokensUsed' },
        },
      },
    ]);

    const tokensLastMinute = tokensResult[0]?.totalTokens || 0;

    if (tokensLastMinute >= rateLimit.tokensPerMinute) {
      return {
        limited: true,
        limitType: 'tokensPerMinute',
        current: tokensLastMinute,
        limit: rateLimit.tokensPerMinute,
        resetInSeconds: 60,
      };
    }
  }

  // Check tokens per day
  if (rateLimit.tokensPerDay !== null) {
    const tokensResult = await ApiKeyUsage.aggregate([
      {
        $match: {
          oxyUserId: userId,
          authType: 'session',
          timestamp: { $gte: oneDayAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalTokens: { $sum: '$tokensUsed' },
        },
      },
    ]);

    const tokensLastDay = tokensResult[0]?.totalTokens || 0;

    if (tokensLastDay >= rateLimit.tokensPerDay) {
      const endOfWindow = new Date(oneDayAgo.getTime() + 24 * 60 * 60 * 1000);
      const resetInSeconds = Math.ceil((endOfWindow.getTime() - now.getTime()) / 1000);

      return {
        limited: true,
        limitType: 'tokensPerDay',
        current: tokensLastDay,
        limit: rateLimit.tokensPerDay,
        resetInSeconds: Math.max(resetInSeconds, 60),
      };
    }
  }

  return { limited: false };
}

/**
 * Check if an API key has exceeded its rate limits
 */
async function checkApiKeyRateLimits(
  apiKeyId: string,
  rateLimit: IRateLimitConfig
): Promise<RateLimitStatus> {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const keyObjectId = new mongoose.Types.ObjectId(apiKeyId);

  // Check requests per minute
  if (rateLimit.requestsPerMinute !== null) {
    const requestsLastMinute = await ApiKeyUsage.countDocuments({
      apiKeyId: keyObjectId,
      timestamp: { $gte: oneMinuteAgo },
    });

    if (requestsLastMinute >= rateLimit.requestsPerMinute) {
      return {
        limited: true,
        limitType: 'requestsPerMinute',
        current: requestsLastMinute,
        limit: rateLimit.requestsPerMinute,
        resetInSeconds: 60,
      };
    }
  }

  // Check requests per day
  if (rateLimit.requestsPerDay !== null) {
    const requestsLastDay = await ApiKeyUsage.countDocuments({
      apiKeyId: keyObjectId,
      timestamp: { $gte: oneDayAgo },
    });

    if (requestsLastDay >= rateLimit.requestsPerDay) {
      // Calculate seconds until reset (next day boundary)
      const endOfWindow = new Date(oneDayAgo.getTime() + 24 * 60 * 60 * 1000);
      const resetInSeconds = Math.ceil((endOfWindow.getTime() - now.getTime()) / 1000);

      return {
        limited: true,
        limitType: 'requestsPerDay',
        current: requestsLastDay,
        limit: rateLimit.requestsPerDay,
        resetInSeconds: Math.max(resetInSeconds, 60),
      };
    }
  }

  // Check tokens per minute
  if (rateLimit.tokensPerMinute !== null) {
    const tokensResult = await ApiKeyUsage.aggregate([
      {
        $match: {
          apiKeyId: keyObjectId,
          timestamp: { $gte: oneMinuteAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalTokens: { $sum: '$tokensUsed' },
        },
      },
    ]);

    const tokensLastMinute = tokensResult[0]?.totalTokens || 0;

    if (tokensLastMinute >= rateLimit.tokensPerMinute) {
      return {
        limited: true,
        limitType: 'tokensPerMinute',
        current: tokensLastMinute,
        limit: rateLimit.tokensPerMinute,
        resetInSeconds: 60,
      };
    }
  }

  // Check tokens per day
  if (rateLimit.tokensPerDay !== null) {
    const tokensResult = await ApiKeyUsage.aggregate([
      {
        $match: {
          apiKeyId: keyObjectId,
          timestamp: { $gte: oneDayAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalTokens: { $sum: '$tokensUsed' },
        },
      },
    ]);

    const tokensLastDay = tokensResult[0]?.totalTokens || 0;

    if (tokensLastDay >= rateLimit.tokensPerDay) {
      const endOfWindow = new Date(oneDayAgo.getTime() + 24 * 60 * 60 * 1000);
      const resetInSeconds = Math.ceil((endOfWindow.getTime() - now.getTime()) / 1000);

      return {
        limited: true,
        limitType: 'tokensPerDay',
        current: tokensLastDay,
        limit: rateLimit.tokensPerDay,
        resetInSeconds: Math.max(resetInSeconds, 60),
      };
    }
  }

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

      const status = await checkApiKeyRateLimits(req.apiKey.id, rateLimit);

      if (status.limited) {
        return sendRateLimitResponse(res, status);
      }

      return next();
    } catch (error) {
      console.error('API key rate limit check error:', error);
      return next();
    }
  }

  // Handle session-based user rate limiting
  if (req.user?.id && !req.apiKey) {
    try {
      const tier = await getUserTier(req.user.id);
      const rateLimit = TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS.free;

      const status = await checkUserRateLimits(req.user.id, rateLimit);

      if (status.limited) {
        return sendRateLimitResponse(res, status, tier);
      }

      return next();
    } catch (error) {
      console.error('User rate limit check error:', error);
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
    console.error('Failed to record usage:', error);
  }
}
