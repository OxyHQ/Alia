import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import ApiKeyUsage from '../models/api-key-usage.js';

const router = Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userCredits = await getOrCreateUserCredits(req.user!.id);
    await userCredits.refreshCreditsIfNeeded();

    res.json({
      credits: userCredits.credits.free + userCredits.credits.paid,
      freeCredits: userCredits.credits.free,
      freeLimit: userCredits.credits.freeLimit,
      paidCredits: userCredits.credits.paid,
      dailyRefresh: userCredits.credits.dailyRefresh,
      lastRefresh: userCredits.credits.lastRefresh,
    });
  } catch (error: any) {
    console.error('[Credits] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get daily credit usage history
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const period = (req.query.period as string) || '7d';
    const periodMap: Record<string, number> = { '24h': 1, '48h': 2, '72h': 3, '7d': 7, '30d': 30 };
    const days = periodMap[period] ?? 7;
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const usage = await ApiKeyUsage.aggregate([
      {
        $match: {
          oxyUserId: req.user!.id,
          timestamp: { $gte: since },
          $or: [
            { creditsUsed: { $gt: 0 } },
            { tokensUsed: { $gt: 0 } },
          ],
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' },
          },
          used: {
            $sum: {
              $cond: {
                if: { $gt: ['$creditsUsed', 0] },
                then: '$creditsUsed',
                else: { $max: [{ $ceil: { $divide: ['$tokensUsed', 1000] } }, 1] },
              },
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Build a complete array with all days (fill gaps with 0)
    const result: { date: string; used: number }[] = [];
    const usageMap = new Map(usage.map((u: any) => [u._id, u.used]));
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      result.push({ date: key, used: (usageMap.get(key) as number) || 0 });
    }

    res.json(result);
  } catch (error: any) {
    console.error('[Credits] Usage error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
