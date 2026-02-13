import ApiKeyUsage from '../models/api-key-usage.js';
import { UserCredits } from '../models/user-credits.js';

export interface CreditWarning {
  level: 'warning' | 'critical';
  daysRemaining: number;
  todaySpend: number;
  avgDailySpend: number;
}

/**
 * Detect abnormal credit spending by comparing today's spend to the 7-day average.
 * Returns a warning if today's spend is 2x+ the average, or null otherwise.
 */
export async function detectCreditAnomaly(userId: string): Promise<CreditWarning | null> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const creditSumExpr = {
    $sum: {
      $cond: {
        if: { $gt: ['$creditsUsed', 0] },
        then: '$creditsUsed',
        else: { $max: [{ $ceil: { $divide: ['$tokensUsed', 1000] } }, 1] },
      },
    },
  };

  const [dailySpending, todayResult, userCredits] = await Promise.all([
    // Last 7 days (excluding today) grouped by day
    ApiKeyUsage.aggregate([
      {
        $match: {
          oxyUserId: userId,
          timestamp: { $gte: sevenDaysAgo, $lt: todayStart },
          $or: [{ creditsUsed: { $gt: 0 } }, { tokensUsed: { $gt: 0 } }],
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          used: creditSumExpr,
        },
      },
    ]),
    // Today's spend
    ApiKeyUsage.aggregate([
      {
        $match: {
          oxyUserId: userId,
          timestamp: { $gte: todayStart },
          $or: [{ creditsUsed: { $gt: 0 } }, { tokensUsed: { $gt: 0 } }],
        },
      },
      { $group: { _id: null, used: creditSumExpr } },
    ]),
    // Current credit balance
    UserCredits.findById(userId),
  ]);

  const todaySpend = todayResult[0]?.used || 0;
  if (todaySpend === 0) return null;

  const totalCredits = userCredits
    ? (userCredits.credits?.free || 0) + (userCredits.credits?.paid || 0)
    : 0;

  // No history — only warn if credits are critically low
  if (dailySpending.length === 0) {
    if (totalCredits > 0) {
      const daysRemaining = totalCredits / todaySpend;
      if (daysRemaining <= 1) {
        return { level: 'critical', daysRemaining: Math.round(daysRemaining * 10) / 10, todaySpend, avgDailySpend: 0 };
      }
    }
    return null;
  }

  // Average over 7 calendar days (including zero-usage days) to avoid inflating the baseline
  const totalHistorical = dailySpending.reduce((sum: number, d: any) => sum + d.used, 0);
  const avgDailySpend = totalHistorical / 7;

  // Too low to detect meaningful anomalies
  if (avgDailySpend < 5) return null;

  const ratio = todaySpend / avgDailySpend;

  let level: 'warning' | 'critical' | null = null;
  if (ratio >= 3) level = 'critical';
  else if (ratio >= 2) level = 'warning';

  if (!level) return null;

  const daysRemaining = todaySpend > 0
    ? Math.max(0, Math.round((totalCredits / todaySpend) * 10) / 10)
    : 999;

  return { level, daysRemaining, todaySpend, avgDailySpend: Math.round(avgDailySpend) };
}
