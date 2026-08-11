import { creditSpendByDay, creditSpendTotal } from '../db/telemetry/apiKeyUsageRepository.js';
import { getDb } from '../db/index.js';
import { findUserCredits, type UserCreditsRow } from '../db/billing/userCreditsRepository.js';

export interface CreditWarning {
  level: 'warning' | 'critical';
  daysRemaining: number;
  todaySpend: number;
  avgDailySpend: number;
  currentModelMultiplier?: number;
}

// In-memory per-user anomaly cache (5-min TTL)
const anomalyCache = new Map<string, { result: CreditWarning | null; expiresAt: number }>();
const ANOMALY_CACHE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of anomalyCache.entries()) {
    if (entry.expiresAt < now) anomalyCache.delete(key);
  }
}, 60_000).unref?.();

/**
 * Calculate days remaining accounting for daily credit refresh.
 * If spending exceeds daily refresh, returns days until paid+free credits deplete.
 * If spending is within daily refresh and no paid credits, returns 999 (no risk).
 */
function calculateDaysRemaining(todaySpend: number, userCredits: UserCreditsRow | null): number {
  /**
   * `?? 0` rather than `|| 0`, and the balance row rather than a Mongoose
   * document. The source read `userCredits?.credits?.free`, and after the
   * sub-document became `credits_*` columns that path is `undefined` — which
   * `|| 0` turns into a balance of ZERO, silently, in the low-credit warning.
   * A missed shape read is the quiet half of this port; a missed model call
   * throws.
   */
  const freeCredits = userCredits?.creditsFree ?? 0;
  const paidCredits = userCredits?.creditsPaid ?? 0;
  const dailyRefresh = userCredits?.creditsDailyRefresh ?? 0;
  const totalCredits = freeCredits + paidCredits;

  if (totalCredits <= 0) return 0;

  const dailyDeficit = todaySpend - dailyRefresh;
  if (dailyDeficit <= 0) {
    // Spending within daily refresh — paid credits stay intact
    return 999;
  }

  return Math.max(0, Math.round((totalCredits / dailyDeficit) * 10) / 10);
}

/**
 * Detect abnormal credit spending by comparing today's spend to the 7-day average.
 * Returns a warning if today's spend is 2x+ the average, or null otherwise.
 */
export async function detectCreditAnomaly(userId: string): Promise<CreditWarning | null> {
  const cached = anomalyCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const [dailySpending, todaySpend, userCredits] = await Promise.all([
    // Last 7 days, excluding today, grouped by UTC day. The credits-or-tokens
    // filter and the per-row credit expression live in the repository, together:
    // separating them is how a row that spent neither contributes a phantom
    // credit through the `greatest(..., 1)` floor.
    creditSpendByDay(getDb(), userId, sevenDaysAgo, todayStart),
    // Today's spend
    creditSpendTotal(getDb(), userId, todayStart),
    // Current credit balance
    findUserCredits(getDb(), userId),
  ]);
  if (todaySpend === 0) {
    anomalyCache.set(userId, { result: null, expiresAt: Date.now() + ANOMALY_CACHE_TTL_MS });
    return null;
  }

  // No history — only warn if credits are critically low
  if (dailySpending.length === 0) {
    const daysRemaining = calculateDaysRemaining(todaySpend, userCredits);
    if (daysRemaining <= 1) {
      const result: CreditWarning = { level: 'critical', daysRemaining, todaySpend, avgDailySpend: 0 };
      anomalyCache.set(userId, { result, expiresAt: Date.now() + ANOMALY_CACHE_TTL_MS });
      return result;
    }
    anomalyCache.set(userId, { result: null, expiresAt: Date.now() + ANOMALY_CACHE_TTL_MS });
    return null;
  }

  // Average over 7 calendar days (including zero-usage days) to avoid inflating the baseline
  const totalHistorical = dailySpending.reduce((sum, day) => sum + day.used, 0);
  const avgDailySpend = totalHistorical / 7;

  // Too low to detect meaningful anomalies
  if (avgDailySpend < 5) {
    anomalyCache.set(userId, { result: null, expiresAt: Date.now() + ANOMALY_CACHE_TTL_MS });
    return null;
  }

  const ratio = todaySpend / avgDailySpend;

  let level: 'warning' | 'critical' | null = null;
  if (ratio >= 3) level = 'critical';
  else if (ratio >= 2) level = 'warning';

  if (!level) {
    anomalyCache.set(userId, { result: null, expiresAt: Date.now() + ANOMALY_CACHE_TTL_MS });
    return null;
  }

  const daysRemaining = calculateDaysRemaining(todaySpend, userCredits);
  const result: CreditWarning = { level, daysRemaining, todaySpend, avgDailySpend: Math.round(avgDailySpend) };
  anomalyCache.set(userId, { result, expiresAt: Date.now() + ANOMALY_CACHE_TTL_MS });
  return result;
}
