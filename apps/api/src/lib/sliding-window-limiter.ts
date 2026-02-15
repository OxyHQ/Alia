/**
 * Sliding Window Rate Limiter (in-memory)
 * Replaces MongoDB-based rate limiting with sub-microsecond in-memory checks.
 * Also tracks daily cost to prevent runaway spending.
 */

interface WindowState {
  timestamps: number[];   // Request timestamps within window
  costToday: number;      // Credits consumed today
  lastResetDay: number;   // Day-of-year when costToday was last reset
}

const windows = new Map<string, WindowState>();

// Cost/day caps per subscription tier (in credits)
const COST_DAY_CAPS: Record<string, number> = {
  free: 500,
  pro: 5000,
  pro_plus: 15000,
  business: 50000,
  enterprise: -1, // unlimited
};

// Requests/minute limits per tier (same as existing TIER_RATE_LIMITS)
const RPM_LIMITS: Record<string, number> = {
  free: 20,
  pro: 60,
  pro_plus: 120,
  business: 200,
  enterprise: -1, // unlimited
};

function getDayOfYear(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getOrCreateWindow(key: string): WindowState {
  let state = windows.get(key);
  if (!state) {
    state = { timestamps: [], costToday: 0, lastResetDay: getDayOfYear() };
    windows.set(key, state);
  }

  // Reset daily cost if new day
  const today = getDayOfYear();
  if (state.lastResetDay !== today) {
    state.costToday = 0;
    state.lastResetDay = today;
  }

  return state;
}

export interface LimitCheckResult {
  allowed: boolean;
  limitType?: 'rpm' | 'daily_cost';
  current?: number;
  limit?: number;
  resetInSeconds?: number;
}

/**
 * Check if a request should be allowed under the sliding window.
 * Sub-microsecond — no I/O, no async.
 */
export function checkLimit(userId: string, tier: string): LimitCheckResult {
  const state = getOrCreateWindow(userId);
  const now = Date.now();
  const windowMs = 60_000; // 1 minute

  // Prune timestamps older than the window
  state.timestamps = state.timestamps.filter(t => now - t < windowMs);

  // Check requests per minute
  const rpmLimit = RPM_LIMITS[tier] ?? RPM_LIMITS.free;
  if (rpmLimit > 0 && state.timestamps.length >= rpmLimit) {
    const oldestInWindow = state.timestamps[0];
    const resetInSeconds = Math.ceil((oldestInWindow + windowMs - now) / 1000);
    return {
      allowed: false,
      limitType: 'rpm',
      current: state.timestamps.length,
      limit: rpmLimit,
      resetInSeconds: Math.max(resetInSeconds, 1),
    };
  }

  // Check daily cost cap
  const costCap = COST_DAY_CAPS[tier] ?? COST_DAY_CAPS.free;
  if (costCap > 0 && state.costToday >= costCap) {
    // Reset at midnight
    const now_ = new Date();
    const midnight = new Date(now_.getFullYear(), now_.getMonth(), now_.getDate() + 1);
    const resetInSeconds = Math.ceil((midnight.getTime() - now_.getTime()) / 1000);
    return {
      allowed: false,
      limitType: 'daily_cost',
      current: state.costToday,
      limit: costCap,
      resetInSeconds,
    };
  }

  // Record the request timestamp
  state.timestamps.push(now);

  return { allowed: true };
}

/**
 * Increment the daily cost counter for a user.
 * Called from finalizeCredits after a request completes.
 */
export function incrementDailyCost(userId: string, credits: number): void {
  const state = getOrCreateWindow(userId);
  state.costToday += credits;
}

/**
 * Get current daily cost for spending alerts.
 */
export function getDailyCost(userId: string): { costToday: number; cap: number } {
  const state = windows.get(userId);
  return {
    costToday: state?.costToday || 0,
    cap: 0, // caller should look up the tier-specific cap
  };
}

/**
 * Get the daily cost cap for a tier.
 */
export function getDailyCostCap(tier: string): number {
  return COST_DAY_CAPS[tier] ?? COST_DAY_CAPS.free;
}

/**
 * Check if user is approaching their daily cost cap (>80%).
 */
export function isApproachingDailyCap(userId: string, tier: string): boolean {
  const state = windows.get(userId);
  if (!state) return false;
  const cap = COST_DAY_CAPS[tier] ?? COST_DAY_CAPS.free;
  if (cap <= 0) return false; // unlimited
  return state.costToday >= cap * 0.8;
}
