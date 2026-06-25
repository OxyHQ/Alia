/**
 * Logs API Route (Admin Only)
 *
 * Provides paginated request logs from FallbackEvent data for the admin panel.
 * Supports filtering by provider, model, status, and time range.
 */

import express, { Request, Response } from 'express';
import { FallbackEvent, type IFallbackAttemptRecord } from '../models/fallback-event.js';
import { log } from '../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/logs
 *
 * Returns paginated request logs with filtering.
 * Query params:
 *   - provider (string, optional) - Filter by final provider
 *   - model (string, optional) - Search in aliasModel (partial match)
 *   - status (string, optional) - "success" | "error" | "all" (default: "all")
 *   - hours (number, default: 24) - Time window in hours (1h, 6h, 24h, 168h=7d)
 *   - page (number, default: 1) - Page number
 *   - limit (number, default: 50) - Items per page (max 200)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 720);
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const skip = (page - 1) * limit;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Build match filter
    const match: Record<string, unknown> = { timestamp: { $gte: since } };

    if (req.query.provider && req.query.provider !== 'all') {
      match['$or'] = [
        { finalProvider: req.query.provider },
        { 'attempts.provider': req.query.provider },
      ];
    }

    if (req.query.model) {
      // Escape user input so it is matched as a literal substring — never as an
      // attacker-controlled regular expression (ReDoS / injection).
      const escaped = String(req.query.model).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      match.aliasModel = { $regex: escaped, $options: 'i' };
    }

    if (req.query.status === 'success') {
      match.success = true;
    } else if (req.query.status === 'error') {
      match.success = false;
    }

    // Run count and data queries in parallel
    const [totalCount, logs] = await Promise.all([
      FallbackEvent.countDocuments(match),
      FallbackEvent.find(match)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // Map to response format
    const items = logs.map((event) => {
      const attempts: IFallbackAttemptRecord[] = (event.attempts as IFallbackAttemptRecord[] | undefined) || [];
      const failedAttempts = attempts.filter((a) => a.error || a.reason);
      const hadFallback = attempts.length > 1;

      return {
        _id: event._id,
        timestamp: event.timestamp,
        aliasModel: event.aliasModel,
        finalProvider: event.finalProvider,
        finalModel: event.finalModel,
        success: event.success,
        totalLatencyMs: event.totalLatencyMs,
        attemptCount: attempts.length,
        hadFallback,
        attempts: attempts.map((a) => ({
          provider: a.provider,
          model: a.model,
          error: a.error,
          reason: a.reason,
          latencyMs: a.latencyMs,
        })),
        failureReasons: failedAttempts.map((a) => a.reason).filter(Boolean),
      };
    });

    res.json({
      success: true,
      data: {
        items,
        pagination: {
          page,
          limit,
          totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting logs');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/logs/stats
 *
 * Returns summary stats for the logs page header.
 * Query params:
 *   - hours (number, default: 24) - Time window in hours
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 720);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const [result] = await FallbackEvent.aggregate([
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          successCount: { $sum: { $cond: ['$success', 1, 0] } },
          errorCount: { $sum: { $cond: ['$success', 0, 1] } },
          avgLatencyMs: { $avg: '$totalLatencyMs' },
          fallbackCount: {
            $sum: {
              $cond: [{ $gt: [{ $size: '$attempts' }, 1] }, 1, 0],
            },
          },
        },
      },
    ]);

    const stats = result || {
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      avgLatencyMs: 0,
      fallbackCount: 0,
    };

    const errorRate = stats.totalRequests > 0
      ? Math.round((stats.errorCount / stats.totalRequests) * 1000) / 10
      : 0;

    const fallbackRate = stats.totalRequests > 0
      ? Math.round((stats.fallbackCount / stats.totalRequests) * 1000) / 10
      : 0;

    res.json({
      success: true,
      data: {
        totalRequests: stats.totalRequests,
        errorRate,
        fallbackRate,
        avgLatencyMs: Math.round(stats.avgLatencyMs || 0),
      },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting log stats');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/logs/providers
 *
 * Returns distinct providers from recent events for filter dropdowns.
 */
router.get('/providers', async (req: Request, res: Response) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 168, 1), 720);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const providers = await FallbackEvent.distinct('finalProvider', {
      timestamp: { $gte: since },
      finalProvider: { $ne: null },
    });

    // Also get providers from attempts
    const attemptProviders = await FallbackEvent.aggregate<{ _id: string }>([
      { $match: { timestamp: { $gte: since } } },
      { $unwind: '$attempts' },
      { $group: { _id: '$attempts.provider' } },
    ]);

    const allProviders = new Set([
      ...providers,
      ...attemptProviders.map((p) => p._id),
    ]);

    res.json({
      success: true,
      data: Array.from(allProviders).filter(Boolean).sort(),
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting log providers');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
