/**
 * Dashboard Stats API Routes (Admin Only)
 * Aggregated data specifically for the admin dashboard overview.
 */

import express, { Request, Response } from 'express';
import { ProviderKey } from '../models/provider-key.js';
import { ApiUsage } from '../models/api-usage.js';
import { UserCredits } from '../models/billing-refs.js';
import { getAllProviderHealth, type HealthMetrics } from '../lib/provider-health.js';
import { log } from '../lib/logger.js';

interface ProviderKeyStats {
  _id: unknown;
  name: string;
  provider: string;
  keyPrefix: string;
  isActive: boolean;
  isPaid: boolean;
  tier: string;
  consecutiveFailures: number;
  totalFailures: number;
  isArchived: boolean;
  archivedAt?: Date;
  archivedReason?: string;
  creditLimitUSD?: number | null;
  spentUSD: number;
  totalRequests: number;
  successCount: number;
}

interface AggregateTimelineResult {
  _id: string;
  requests: number;
  tokens: number;
}

interface AggregateProviderResult {
  _id: string;
  requests: number;
  tokens: number;
}

const router = express.Router();

// --------------- In-memory cache ---------------
interface DashboardCache {
  data: Record<string, unknown>;
  expiresAt: number;
}

let dashboardCache: DashboardCache | null = null;
const DASHBOARD_CACHE_TTL = 30_000;

/**
 * POST /v1/dashboard-stats/invalidate
 * Clears the in-memory cache so the next GET returns fresh data.
 */
router.post('/invalidate', (_req: Request, res: Response) => {
  dashboardCache = null;
  res.json({ success: true, message: 'Dashboard cache invalidated' });
});

/**
 * GET /v1/dashboard-stats
 * Returns aggregated stats for the admin dashboard in one call.
 * Results are cached in-memory for 30 seconds to avoid saturating the
 * MongoDB connection pool under concurrent admin access.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    if (dashboardCache && Date.now() < dashboardCache.expiresAt) {
      return res.json({ success: true, data: dashboardCache.data, cached: true });
    }

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Run all queries in parallel
    const [
      health,
      keys,
      requestsTimeline,
      topModels,
      costsByProvider24h,
      costsByProvider7d,
      costsByProvider30d,
      creditsOverview,
    ] = await Promise.all([
      // 1. Provider health
      getAllProviderHealth(),

      // 2. All keys (excluding keyHash/key)
      ProviderKey.find({}).select(
        'name provider keyPrefix isActive isPaid tier consecutiveFailures totalFailures isArchived archivedAt archivedReason creditLimitUSD spentUSD totalRequests successCount'
      ).lean(),

      // 3. Requests timeline (last 24h, grouped by hour)
      ApiUsage.aggregate([
        { $match: { timestamp: { $gte: twentyFourHoursAgo } } },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%dT%H:00:00', date: '$timestamp' },
            },
            requests: { $sum: 1 },
            tokens: { $sum: '$tokens' },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // 4. Top models by request count (last 7d)
      ApiUsage.aggregate([
        { $match: { timestamp: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: '$modelId',
            requests: { $sum: 1 },
            tokens: { $sum: '$tokens' },
          },
        },
        { $sort: { requests: -1 } },
        { $limit: 8 },
      ]),

      // 5a. Spend by provider (24h) — from key spentUSD and usage counts
      ApiUsage.aggregate([
        { $match: { timestamp: { $gte: twentyFourHoursAgo } } },
        {
          $group: {
            _id: '$provider',
            requests: { $sum: 1 },
            tokens: { $sum: '$tokens' },
          },
        },
        { $sort: { requests: -1 } },
      ]),

      // 5b. Spend by provider (7d)
      ApiUsage.aggregate([
        { $match: { timestamp: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: '$provider',
            requests: { $sum: 1 },
            tokens: { $sum: '$tokens' },
          },
        },
        { $sort: { requests: -1 } },
      ]),

      // 5c. Spend by provider (30d)
      ApiUsage.aggregate([
        { $match: { timestamp: { $gte: thirtyDaysAgo } } },
        {
          $group: {
            _id: '$provider',
            requests: { $sum: 1 },
            tokens: { $sum: '$tokens' },
          },
        },
        { $sort: { requests: -1 } },
      ]),

      // 6. Credits overview
      UserCredits.aggregate([
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            totalBalance: { $sum: '$balance' },
            totalEarned: { $sum: '$totalEarned' },
            totalSpent: { $sum: '$totalSpent' },
          },
        },
      ]),
    ]);

    // Process keys into alerts
    const allKeys = keys as ProviderKeyStats[];
    const failingKeys = allKeys.filter(
      (k) => !k.isArchived && k.consecutiveFailures > 3
    );
    const nearCreditLimitKeys = allKeys.filter(
      (k) =>
        !k.isArchived &&
        k.creditLimitUSD != null &&
        k.creditLimitUSD > 0 &&
        k.spentUSD / k.creditLimitUSD > 0.8
    );

    // Process health into alerts
    const healthArr: HealthMetrics[] = health;
    const openCircuitBreakers = healthArr.filter(
      (h) => h.circuitState === 'open'
    );

    // Build cost overview from key spend data
    const keysByProvider: Record<string, { spent: number; limit: number | null; count: number }> = {};
    for (const k of allKeys) {
      if (k.isArchived) continue;
      if (!keysByProvider[k.provider]) {
        keysByProvider[k.provider] = { spent: 0, limit: null, count: 0 };
      }
      keysByProvider[k.provider].spent += k.spentUSD || 0;
      keysByProvider[k.provider].count += 1;
      if (k.creditLimitUSD != null) {
        keysByProvider[k.provider].limit =
          (keysByProvider[k.provider].limit || 0) + k.creditLimitUSD;
      }
    }

    // Build average latency per provider from health data
    const latencyByProvider: Record<string, { totalLatency: number; count: number }> = {};
    for (const h of healthArr) {
      if (!latencyByProvider[h.provider]) {
        latencyByProvider[h.provider] = { totalLatency: 0, count: 0 };
      }
      latencyByProvider[h.provider].totalLatency += h.averageLatencyMs || 0;
      latencyByProvider[h.provider].count += 1;
    }

    const avgLatencyPerProvider = Object.entries(latencyByProvider).map(
      ([provider, data]) => ({
        provider,
        averageLatencyMs: Math.round(data.totalLatency / data.count),
        modelCount: data.count,
      })
    ).sort((a, b) => a.averageLatencyMs - b.averageLatencyMs);

    const responseData: Record<string, unknown> = {
      requestsTimeline: (requestsTimeline as AggregateTimelineResult[]).map((r) => ({
        time: r._id,
        requests: r.requests,
        tokens: r.tokens,
      })),
      topModels: (topModels as AggregateTimelineResult[]).map((m) => ({
        modelId: m._id,
        requests: m.requests,
        tokens: m.tokens,
      })),
      costsByProvider: {
        daily: (costsByProvider24h as AggregateProviderResult[]).map((c) => ({
          provider: c._id,
          requests: c.requests,
          tokens: c.tokens,
        })),
        weekly: (costsByProvider7d as AggregateProviderResult[]).map((c) => ({
          provider: c._id,
          requests: c.requests,
          tokens: c.tokens,
        })),
        monthly: (costsByProvider30d as AggregateProviderResult[]).map((c) => ({
          provider: c._id,
          requests: c.requests,
          tokens: c.tokens,
        })),
      },
      spendByProvider: Object.entries(keysByProvider).map(
        ([provider, data]) => ({
          provider,
          spentUSD: Number(data.spent.toFixed(4)),
          creditLimitUSD: data.limit,
          keyCount: data.count,
        })
      ),
      alerts: {
        failingKeys: failingKeys.map((k) => ({
          id: k._id,
          name: k.name,
          provider: k.provider,
          keyPrefix: k.keyPrefix,
          consecutiveFailures: k.consecutiveFailures,
        })),
        openCircuitBreakers: openCircuitBreakers.map((h) => ({
          provider: h.provider,
          modelId: h.modelId,
          successRate: h.successRate,
          consecutiveFailures: h.consecutiveFailures,
        })),
        nearCreditLimitKeys: nearCreditLimitKeys.map((k) => ({
          id: k._id,
          name: k.name,
          provider: k.provider,
          keyPrefix: k.keyPrefix,
          spentUSD: k.spentUSD,
          creditLimitUSD: k.creditLimitUSD,
          percentUsed: Math.round((k.spentUSD / (k.creditLimitUSD ?? 1)) * 100),
        })),
      },
      avgLatencyPerProvider,
      creditsOverview: creditsOverview[0] || {
        totalUsers: 0,
        totalBalance: 0,
        totalEarned: 0,
        totalSpent: 0,
      },
    };

    dashboardCache = { data: responseData, expiresAt: Date.now() + DASHBOARD_CACHE_TTL };

    res.json({ success: true, data: responseData });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting dashboard stats');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
