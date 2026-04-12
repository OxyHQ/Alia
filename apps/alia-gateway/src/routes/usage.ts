/**
 * Usage API Routes (Admin Only)
 * Provides global usage analytics for the admin panel.
 */

import express, { Request, Response } from 'express';
import ApiKeyUsage from '../models/billing-refs.js';
import { log } from '../lib/logger.js';

const router = express.Router();

const ALLOWED_PERIODS = ['24h', '7d', '30d', '90d'];

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
    let period = (req.query.period as string) || '7d';
    if (!ALLOWED_PERIODS.includes(period)) period = '7d';
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
  } catch (error: unknown) {
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
    let period = (req.query.period as string) || '7d';
    if (!ALLOWED_PERIODS.includes(period)) period = '7d';
    const startDate = getStartDate(period);

    // Cost breakdown from aggregated usage data
    const [byProvider, byModel] = await Promise.all([
      ApiKeyUsage.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        {
          $group: {
            _id: '$provider',
            totalCredits: { $sum: '$creditsUsed' },
            requests: { $sum: 1 },
          },
        },
        { $sort: { totalCredits: -1 } },
      ]),
      ApiKeyUsage.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        {
          $group: {
            _id: '$model',
            totalCredits: { $sum: '$creditsUsed' },
            requests: { $sum: 1 },
          },
        },
        { $sort: { totalCredits: -1 } },
        { $limit: 10 },
      ]),
    ]);

    res.json({
      success: true,
      data: { totalCostUSD: 0, byProvider, byModel },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting cost stats');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
