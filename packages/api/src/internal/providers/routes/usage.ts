/**
 * Usage API Routes (Admin Only)
 * Provides global usage analytics for the admin panel.
 */

import express, { Request, Response } from 'express';
import {
  usageByDay,
  usageByEndpoint,
  usageSummary,
  type UsageScope,
} from '../../../db/telemetry/apiKeyUsageRepository.js';
import { getDb } from '../../../db/index.js';
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

    const scope: UsageScope = { kind: 'platform' };
    const [summary, byDay, byEndpoint] = await Promise.all([
      usageSummary(getDb(), scope, startDate),
      usageByDay(getDb(), scope, startDate),
      usageByEndpoint(getDb(), scope, startDate),
    ]);

    res.json({
      success: true,
      data: {
        summary,
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
    const period = (req.query.period as string) || '7d';
    const startDate = getStartDate(period);

    const stats = await getGlobalCostStats(startDate, new Date());

    res.json({
      success: true,
      data: stats,
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
