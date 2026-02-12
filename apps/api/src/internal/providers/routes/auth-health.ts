/**
 * Auth Health Routes (Admin Only)
 * Provides auth health monitoring stats for the admin dashboard.
 */

import express, { Request, Response } from 'express';
import { getAuthHealthStats } from '../../../lib/auth-health.js';

const router = express.Router();

// Note: Service authentication is applied at mount point in index.ts

/**
 * GET /v1/auth-health
 * Returns auth health stats aggregated by method for the last N hours (default 24).
 * Query params:
 *   - hours (number, optional): lookback window in hours (default 24, max 168 = 7 days)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const hoursParam = parseInt(req.query.hours as string, 10);
    const hours = isNaN(hoursParam) || hoursParam < 1 ? 24 : Math.min(hoursParam, 168);

    const stats = await getAuthHealthStats(hours);

    const allHealthy = stats.length === 0 || stats.every((s) => s.isHealthy);

    res.json({
      success: true,
      data: {
        hours,
        overallHealthy: allHealthy,
        methods: stats,
      },
    });
  } catch (error: any) {
    console.error('Error getting auth health stats:', error);
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
