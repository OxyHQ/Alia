import type { Subscription } from '@/lib/hooks/use-billing';
import type { CreditsInfo } from '@/lib/hooks/use-credits';
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
 * One rolling limit exists: the daily free allowance (`freeCredits` left of
 * `freeLimit`, refilled 24h after `lastRefresh`). The paid balance is not a
 * limit — it accumulates from plan renewals and purchases alike, and nothing
 * records how much of a month's plan credits were spent — so it is not drawn
 * as a share. There is no context-window number in Alia either, so the card
 * gets no `context`.
 */
export function agentLimitsProps(
  credits: CreditsInfo | undefined,
  subscription: Subscription | null | undefined,
  now: number,
  t: Translate,
): { plan: string; limits: AgentLimitsUsageLimit[] } {
  const plan = subscription?.status === 'active' ? subscription.plan.name : t('credits.free');
  const limits: AgentLimitsUsageLimit[] = [];
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
