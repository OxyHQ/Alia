/**
 * Fallback Stats API Route (Admin Only)
 *
 * Provides aggregated fallback analytics from FallbackEvent data.
 * Used by the admin panel to monitor fallback behavior and provider reliability.
 */

import express, { Request, Response } from 'express';
import { FallbackEvent } from '../models/fallback-event';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/fallback-stats
 *
 * Returns aggregated fallback statistics for a given time window.
 * Query params:
 *   - hours (number, default: 24) - Time window in hours
 *
 * Returns:
 *   - summary: total events, success/failure counts, fallback rate
 *   - topFailureReasons: most common failure reasons with counts
 *   - mostFailedProviders: providers with the most failures
 *   - failuresByModel: failures grouped by alias model
 *   - recentFailures: last 20 failed fallback events
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 720); // 1h to 30d
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Run all aggregation queries in parallel
    const [
      summaryResult,
      topFailureReasons,
      mostFailedProviders,
      failuresByModel,
      recentFailures,
    ] = await Promise.all([
      // Summary stats
      FallbackEvent.aggregate([
        { $match: { timestamp: { $gte: since } } },
        {
          $group: {
            _id: null,
            totalEvents: { $sum: 1 },
            successCount: { $sum: { $cond: ['$success', 1, 0] } },
            failureCount: { $sum: { $cond: ['$success', 0, 1] } },
            avgTotalLatencyMs: { $avg: '$totalLatencyMs' },
            avgAttempts: { $avg: { $size: '$attempts' } },
            maxAttempts: { $max: { $size: '$attempts' } },
          },
        },
      ]),

      // Top failure reasons (across all attempts)
      FallbackEvent.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $unwind: '$attempts' },
        {
          $group: {
            _id: '$attempts.reason',
            count: { $sum: 1 },
            avgLatencyMs: { $avg: '$attempts.latencyMs' },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
        {
          $project: {
            reason: '$_id',
            count: 1,
            avgLatencyMs: { $round: ['$avgLatencyMs', 0] },
            _id: 0,
          },
        },
      ]),

      // Most failed providers
      FallbackEvent.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $unwind: '$attempts' },
        {
          $group: {
            _id: '$attempts.provider',
            failureCount: { $sum: 1 },
            models: { $addToSet: '$attempts.model' },
            reasons: { $push: '$attempts.reason' },
          },
        },
        { $sort: { failureCount: -1 } },
        { $limit: 10 },
        {
          $project: {
            provider: '$_id',
            failureCount: 1,
            modelCount: { $size: '$models' },
            topReason: { $arrayElemAt: ['$reasons', 0] },
            _id: 0,
          },
        },
      ]),

      // Failures by alias model
      FallbackEvent.aggregate([
        { $match: { timestamp: { $gte: since } } },
        {
          $group: {
            _id: '$aliasModel',
            totalEvents: { $sum: 1 },
            failures: { $sum: { $cond: ['$success', 0, 1] } },
            successes: { $sum: { $cond: ['$success', 1, 0] } },
            avgAttempts: { $avg: { $size: '$attempts' } },
          },
        },
        { $sort: { failures: -1 } },
        { $limit: 20 },
        {
          $project: {
            aliasModel: '$_id',
            totalEvents: 1,
            failures: 1,
            successes: 1,
            avgAttempts: { $round: ['$avgAttempts', 1] },
            fallbackRate: {
              $round: [
                {
                  $multiply: [
                    { $divide: ['$failures', { $max: ['$totalEvents', 1] }] },
                    100,
                  ],
                },
                1,
              ],
            },
            _id: 0,
          },
        },
      ]),

      // Recent failures (last 20)
      FallbackEvent.find({ timestamp: { $gte: since }, success: false })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean(),
    ]);

    const summary = summaryResult[0] || {
      totalEvents: 0,
      successCount: 0,
      failureCount: 0,
      avgTotalLatencyMs: 0,
      avgAttempts: 0,
      maxAttempts: 0,
    };

    // Calculate fallback frequency
    const fallbackRate =
      summary.totalEvents > 0
        ? Math.round((summary.failureCount / summary.totalEvents) * 1000) / 10
        : 0;

    res.json({
      success: true,
      data: {
        timeWindow: {
          hours,
          since: since.toISOString(),
        },
        summary: {
          totalEvents: summary.totalEvents,
          successCount: summary.successCount,
          failureCount: summary.failureCount,
          fallbackRate: `${fallbackRate}%`,
          avgTotalLatencyMs: Math.round(summary.avgTotalLatencyMs || 0),
          avgAttempts: Math.round((summary.avgAttempts || 0) * 10) / 10,
          maxAttempts: summary.maxAttempts || 0,
        },
        topFailureReasons,
        mostFailedProviders,
        failuresByModel,
        recentFailures: recentFailures.map((e: any) => ({
          timestamp: e.timestamp,
          aliasModel: e.aliasModel,
          attempts: e.attempts,
          totalLatencyMs: e.totalLatencyMs,
        })),
      },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting fallback stats');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
