/**
 * Usage API Routes (Admin Only)
 * Provides global usage analytics for the admin panel.
 */

import express, { Request, Response } from 'express';
import ApiKeyUsage from '../../../models/api-key-usage';
import { getGlobalCostStats } from '../../../lib/cost-tracker';
import { log } from '../../../lib/logger.js';

const router = express.Router();

function getStartDate(period: string): Date {
  const now = new Date();
  const start = new Date();

  switch (period) {
    case '24h':
      start.setHours(now.getHours() - 24);
      break;
    case '7d':
      start.setDate(now.getDate() - 7);
      break;
    case '30d':
      start.setDate(now.getDate() - 30);
      break;
    case '90d':
      start.setDate(now.getDate() - 90);
      break;
    default:
      start.setDate(now.getDate() - 7);
  }

  return start;
}

/**
 * GET /v1/usage
 * Global usage statistics (all users, all apps)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as string) || '7d';
    const startDate = getStartDate(period);

    const [summary] = await ApiKeyUsage.aggregate([
      { $match: { timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          totalTokens: { $sum: '$tokensUsed' },
          totalCredits: { $sum: '$creditsUsed' },
          avgResponseTime: { $avg: '$responseTime' },
          successfulRequests: {
            $sum: { $cond: [{ $lt: ['$statusCode', 400] }, 1, 0] },
          },
          errorRequests: {
            $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] },
          },
        },
      },
    ]);

    const byDay = await ApiKeyUsage.aggregate([
      { $match: { timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          requests: { $sum: 1 },
          tokens: { $sum: '$tokensUsed' },
          credits: { $sum: '$creditsUsed' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const byEndpoint = await ApiKeyUsage.aggregate([
      { $match: { timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: '$endpoint',
          requests: { $sum: 1 },
          tokens: { $sum: '$tokensUsed' },
        },
      },
      { $sort: { requests: -1 } },
      { $limit: 10 },
    ]);

    res.json({
      success: true,
      data: {
        summary: summary || {
          totalRequests: 0,
          totalTokens: 0,
          totalCredits: 0,
          avgResponseTime: 0,
          successfulRequests: 0,
          errorRequests: 0,
        },
        byDay,
        byEndpoint,
      },
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error getting usage stats');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/usage/costs
 * Cost breakdown from CostEntry data
 */
router.get('/costs', async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as string) || '7d';
    const startDate = getStartDate(period);

    const stats = await getGlobalCostStats(startDate, new Date());

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error getting cost stats');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
