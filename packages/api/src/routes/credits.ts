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

    /**
     * The window is the last `days` days ENDING TODAY, and every date here is
     * UTC.
     *
     * Two bugs lived in the four lines this replaces. The window ran
     * `today − days … today − 1`: the loop emitted `days` keys starting at
     * `since`, so today's bucket was fetched from the database and then thrown
     * away, and the chart was permanently missing the current day — the one
     * day a person looking at their usage most wants to see.
     *
     * And the keys were built from a LOCAL midnight (`setHours(0,0,0,0)`) but
     * read back with `toISOString()`, while `creditSpendByDay` buckets with
     * `to_char(… at time zone 'UTC', 'YYYY-MM-DD')`. On any host east of UTC
     * the local midnight converts to the previous day in UTC, so every emitted
     * key was one day behind every SQL bucket and the whole series read zero.
     * `Date.UTC` keeps the two in the same calendar.
     */
    const today = new Date();
    const startUtc = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - (days - 1),
    );
    const since = new Date(startUtc);

    const usage = await creditSpendByDay(getDb(), req.user!.id, since);

    // Build a complete array with all days (fill gaps with 0)
    const result: { date: string; used: number }[] = [];
    const usageMap = new Map(usage.map((u) => [u._id, u.used]));
    for (let i = 0; i < days; i++) {
      const key = new Date(startUtc + i * 86_400_000).toISOString().slice(0, 10);
      result.push({ date: key, used: usageMap.get(key) ?? 0 });
    }

    res.json(result);
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Usage error');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch credit usage') });
  }
});

export default router;
