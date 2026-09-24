import { getDb } from '../db/index.js';
import { creditSpendWindow } from '../db/telemetry/apiKeyUsageRepository.js';

/**
 * The rolling usage window: how many credits a plan may spend in any five
 * hours. It bounds bursts the way the monthly balance cannot — a balance says
 * how much in total, the window how fast.
 *
 * Measured on what was really charged (`api_key_usage.credits_used`, written by
 * `finalizeChatCredits` for every chat turn), summed over the last
 * `USAGE_WINDOW_HOURS`. A turn that would start with the window already spent
 * is refused before any credit is reserved, and says when it can be tried
 * again: when the oldest spending turn in the window ages out.
 */
export const USAGE_WINDOW_HOURS = 5;
const WINDOW_MS = USAGE_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * Credits per window, by plan id (`lib/seed-plans.ts`). A tenth of the monthly
 * grant for the paid plans, and half the daily free allowance for the free
 * floor. A plan missing here has no window: an unknown plan id is not a reason
 * to refuse somebody who is paying.
 */
export const USAGE_WINDOW_CREDITS: ReadonlyMap<string, number> = new Map([
  ['free', 150],
  ['go', 400],
  ['pro', 1000],
  ['max', 5000],
  ['ultra', 10000],
  // Retired from the offer (drizzle/0075), honoured for whoever still holds them.
  ['codea-pro', 1000],
  ['codea-max', 5000],
]);

export interface UsageWindow {
  hours: number;
  /** Credits spent inside the window. */
  used: number;
  /** Credits the plan may spend inside it. */
  limit: number;
  /** When the oldest spending turn ages out, freeing the window; `null` when nothing is spent. */
  resetsAt: Date | null;
  exhausted: boolean;
}

/** One user's window on their plan, or `null` when the plan has none. */
export async function readUsageWindow(
  oxyUserId: string,
  planId: string,
  now: number = Date.now(),
): Promise<UsageWindow | null> {
  const limit = USAGE_WINDOW_CREDITS.get(planId);
  if (limit === undefined) return null;
  const { used, oldest } = await creditSpendWindow(getDb(), oxyUserId, new Date(now - WINDOW_MS));
  return {
    hours: USAGE_WINDOW_HOURS,
    used,
    limit,
    resetsAt: oldest === null ? null : new Date(oldest.getTime() + WINDOW_MS),
    exhausted: used >= limit,
  };
}

/** Seconds until a refused turn can be tried again (at least one). */
export function secondsUntilReset(window: UsageWindow, now: number = Date.now()): number {
  if (window.resetsAt === null) return 1;
  return Math.max(1, Math.ceil((window.resetsAt.getTime() - now) / 1000));
}
