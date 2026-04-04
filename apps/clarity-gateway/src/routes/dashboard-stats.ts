/**
 * Dashboard Stats API Routes (Admin Only)
 * Aggregated data specifically for the admin dashboard overview.
 */

import express, { Request, Response } from 'express';
import { ProviderKey } from '../models/provider-key.js';
import { ApiUsage } from '../models/api-usage.js';
import { UserCredits } from '../models/billing-refs.js';
import { getAllProviderHealth } from '../lib/provider-health.js';
import { log } from '../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/dashboard-stats
 * Returns aggregated stats for the admin dashboard in one call.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
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
    const allKeys = keys as any[];
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
    const healthArr = (health as any[]) || [];
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

    res.json({
      success: true,
      data: {
        requestsTimeline: requestsTimeline.map((r: any) => ({
          time: r._id,
          requests: r.requests,
          tokens: r.tokens,
        })),
        topModels: topModels.map((m: any) => ({
          modelId: m._id,
          requests: m.requests,
          tokens: m.tokens,
        })),
        costsByProvider: {
          daily: costsByProvider24h.map((c: any) => ({
            provider: c._id,
            requests: c.requests,
            tokens: c.tokens,
          })),
          weekly: costsByProvider7d.map((c: any) => ({
            provider: c._id,
            requests: c.requests,
            tokens: c.tokens,
          })),
          monthly: costsByProvider30d.map((c: any) => ({
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
          failingKeys: failingKeys.map((k: any) => ({
            id: k._id,
            name: k.name,
            provider: k.provider,
            keyPrefix: k.keyPrefix,
            consecutiveFailures: k.consecutiveFailures,
          })),
          openCircuitBreakers: openCircuitBreakers.map((h: any) => ({
            provider: h.provider,
            modelId: h.modelId,
            successRate: h.successRate,
            consecutiveFailures: h.consecutiveFailures,
          })),
          nearCreditLimitKeys: nearCreditLimitKeys.map((k: any) => ({
            id: k._id,
            name: k.name,
            provider: k.provider,
            keyPrefix: k.keyPrefix,
            spentUSD: k.spentUSD,
            creditLimitUSD: k.creditLimitUSD,
            percentUsed: Math.round((k.spentUSD / k.creditLimitUSD) * 100),
          })),
        },
        avgLatencyPerProvider,
        creditsOverview: creditsOverview[0] || {
          totalUsers: 0,
          totalBalance: 0,
          totalEarned: 0,
          totalSpent: 0,
        },
      },
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error getting dashboard stats');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
