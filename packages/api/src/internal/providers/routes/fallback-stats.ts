/**
 * Fallback Stats API Route (Admin Only)
 *
 * Provides aggregated fallback analytics from FallbackEvent data.
 * Used by the admin panel to monitor fallback behavior and provider reliability.
 */

import express, { Request, Response } from 'express';
import {
  failuresByModel,
  mostFailedProviders,
  recentFailures as recentFailedEvents,
  summariseFallbacks,
  topFailureReasons,
} from '../../../db/telemetry/fallbackEventRepository.js';
import { getDb } from '../../../db/index.js';
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

    const db = getDb();

    // Run all aggregation queries in parallel
    const [summary, reasons, providers, byModel, failures] = await Promise.all([
      summariseFallbacks(db, since),
      topFailureReasons(db, since),
      mostFailedProviders(db, since),
      failuresByModel(db, since),
      recentFailedEvents(db, since),
    ]);

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
        topFailureReasons: reasons,
        mostFailedProviders: providers,
        failuresByModel: byModel,
        recentFailures: failures.map((e) => ({
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
