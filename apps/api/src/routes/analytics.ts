import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { ChatAnalytics } from '../lib/hooks/built-in/analytics-hook.js';
import { getAliaModel } from '../lib/providers-client.js';
import { log } from '../lib/logger.js';

const router = Router();
router.use(authenticateToken);

// GET /analytics/usage - Usage over time (daily aggregation)
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const usage = await ChatAnalytics.aggregate([
      { $match: { oxyUserId: new mongoose.Types.ObjectId(req.user!.id), createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          conversations: { $sum: 1 },
          totalTokens: { $sum: '$totalTokens' },
          avgLatency: { $avg: '$latencyMs' },
        }
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ usage, period: days });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Analytics query failed');
    res.status(500).json({ error: 'Failed to fetch usage analytics' });
  }
});

// GET /analytics/models - Model usage breakdown
router.get('/models', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const raw = await ChatAnalytics.aggregate([
      { $match: { oxyUserId: new mongoose.Types.ObjectId(req.user!.id), createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $ifNull: ['$aliaModelId', '$model'] },
          count: { $sum: 1 },
          totalTokens: { $sum: '$totalTokens' },
          avgLatency: { $avg: '$latencyMs' },
        }
      },
      { $sort: { count: -1 } },
    ]);

    const models = (await Promise.all(raw.map(async (m) => {
      const aliaModel = await getAliaModel(m._id);
      if (!aliaModel) return null;
      return {
        ...m,
        name: aliaModel.name,
        emoji: aliaModel.emoji,
      };
    }))).filter(Boolean);

    res.json({ models, period: days });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Analytics query failed');
    res.status(500).json({ error: 'Failed to fetch model analytics' });
  }
});

// GET /analytics/credits - Credit consumption over time
router.get('/credits', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const credits = await ChatAnalytics.aggregate([
      { $match: { oxyUserId: new mongoose.Types.ObjectId(req.user!.id), createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          totalTokens: { $sum: '$totalTokens' },
          conversations: { $sum: 1 },
        }
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ credits, period: days });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Analytics query failed');
    res.status(500).json({ error: 'Failed to fetch credit analytics' });
  }
});

export default router;
