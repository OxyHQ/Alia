import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getRefreshedUserCredits } from '../lib/user-credits-helpers.js';
import { creditSpendByDay } from '../db/telemetry/apiKeyUsageRepository.js';
import { getDb } from '../db/index.js';
import { log } from '../lib/logger.js';
import { getSafeErrorMessage } from '../lib/errors/sanitize.js';

const router = Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userCredits = await getRefreshedUserCredits(req.user!.id);

    res.json({
      credits: userCredits.creditsFree + userCredits.creditsPaid,
      freeCredits: userCredits.creditsFree,
      freeLimit: userCredits.creditsFreeLimit,
      paidCredits: userCredits.creditsPaid,
      dailyRefresh: userCredits.creditsDailyRefresh,
      lastRefresh: userCredits.creditsLastRefresh,
    });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch credits') });
  }
});

// Get daily credit usage history
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const period = (req.query.period as string) || '7d';
    const periodMap: Record<string, number> = { '24h': 1, '48h': 2, '72h': 3, '7d': 7, '30d': 30 };
    // `Object.hasOwn`, not `??`. `period` is the caller's own query string and
    // `periodMap` is an object literal: `periodMap['constructor']` is a
    // function, which `??` passes straight through, and `days` then reached
    // `since.setDate(since.getDate() - days)` as a function — an Invalid Date,
    // handed to a database query.
    const days = Object.hasOwn(periodMap, period) ? periodMap[period] : 7;
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const usage = await creditSpendByDay(getDb(), req.user!.id, since);

    // Build a complete array with all days (fill gaps with 0)
    const result: { date: string; used: number }[] = [];
    const usageMap = new Map(usage.map((u) => [u._id, u.used]));
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      result.push({ date: key, used: usageMap.get(key) ?? 0 });
    }

    res.json(result);
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Usage error');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch credit usage') });
  }
});

export default router;
