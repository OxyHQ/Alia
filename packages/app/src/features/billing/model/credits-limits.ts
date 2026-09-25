import type { Subscription } from '@/features/billing/runtime/use-billing';
import type { CreditsInfo } from '@/features/billing/runtime/use-credits';
import type { AgentLimitsUsageLimit } from '@oxy.so/bloom/agent-limits-card';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Free credits refill to `freeLimit` 24 hours after `lastRefresh` (`userCreditsRepository`). */
const FREE_REFRESH_MS = 24 * 60 * 60 * 1000;

/** "Resets in 3 hr 12 min", from the time left until the next free refill. */
function resetsIn(msLeft: number, t: Translate): string {
  if (msLeft <= 0) return t('chat.bloom.limits.resetsSoon');
  const minutes = Math.max(1, Math.ceil(msLeft / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? t('chat.bloom.limits.resetsInHours', { hours, minutes: minutes % 60 })
    : t('chat.bloom.limits.resetsInMinutes', { minutes });
}

/**
 * `AgentLimitsCard`'s plan section, from what `/credits` and the subscription
 * really say.
 *
 * Two rolling limits exist: the plan's usage window (credits spent in the
 * last five hours of what the plan allows, freed as the oldest spend ages out;
 * the API refuses a turn once it is spent), and the daily free allowance
 * (`freeCredits` left of `freeLimit`, refilled 24h after `lastRefresh`). The
 * paid balance is not a limit — it accumulates from plan renewals and purchases
 * alike — so it is not drawn as a share.
 */
export function agentLimitsProps(
  credits: CreditsInfo | undefined,
  subscription: Subscription | null | undefined,
  now: number,
  t: Translate,
): { plan: string; limits: AgentLimitsUsageLimit[] } {
  const plan = subscription?.status === 'active' ? subscription.plan.name : t('credits.free');
  const limits: AgentLimitsUsageLimit[] = [];
  const window = credits?.window;
  if (window && window.limit > 0) {
    const resetsAt = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
    limits.push({
      label: t('chat.bloom.limits.window', { hours: window.hours }),
      used: Math.min(1, Math.max(0, window.used / window.limit)),
      resets: Number.isNaN(resetsAt)
        ? t('chat.bloom.limits.windowFresh', { hours: window.hours })
        : resetsIn(resetsAt - now, t),
    });
  }
  if (credits && credits.freeLimit > 0) {
    const used = (credits.freeLimit - credits.freeCredits) / credits.freeLimit;
    const refreshed = Date.parse(credits.lastRefresh);
    limits.push({
      label: t('chat.bloom.limits.dailyFree'),
      used: Math.min(1, Math.max(0, used)),
      resets: Number.isNaN(refreshed)
        ? t('chat.bloom.limits.resetsDaily')
        : resetsIn(refreshed + FREE_REFRESH_MS - now, t),
    });
  }
  return { plan, limits };
}
