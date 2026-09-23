import { describe, expect, it } from 'vitest';

import type { Subscription } from '@/lib/hooks/use-billing';
import type { CreditsInfo } from '@/lib/hooks/use-credits';

import { agentLimitsProps } from '../credits-limits';

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}${JSON.stringify(params)}` : key;

const NOW = Date.parse('2026-09-23T12:00:00Z');

/** `/credits` as `packages/api/src/routes/credits.ts` answers it. */
const credits = (over: Partial<CreditsInfo> = {}): CreditsInfo => ({
  credits: 1_120,
  freeCredits: 120,
  freeLimit: 300,
  paidCredits: 1_000,
  dailyRefresh: 300,
  lastRefresh: '2026-09-23T02:47:00Z',
  ...over,
});

const subscription = (status: Subscription['status']): Subscription =>
  ({
    status,
    currentPeriodStart: '2026-09-01T00:00:00Z',
    currentPeriodEnd: '2026-10-01T00:00:00Z',
    cancelAtPeriodEnd: false,
    isComped: false,
    plan: { planId: 'p', name: 'Pro', product: 'alia', creditsPerMonth: 5_000, price: 2_000, currency: 'usd', billingPeriod: 'monthly' },
    createdAt: '2026-01-01T00:00:00Z',
  }) as Subscription;

describe('credits → AgentLimitsCard props', () => {
  it('draws the daily free allowance as the share used, resetting 24h after the last refresh', () => {
    expect(agentLimitsProps(credits(), subscription('active'), NOW, t)).toEqual({
      plan: 'Pro',
      limits: [
        {
          label: 'chat.bloom.limits.dailyFree',
          used: 0.6,
          // 02:47 + 24h = 02:47 tomorrow, 14h47m after noon.
          resets: 'chat.bloom.limits.resetsInHours{"hours":14,"minutes":47}',
        },
      ],
    });
  });

  it('names the free plan when there is no active subscription', () => {
    expect(agentLimitsProps(credits(), subscription('canceled'), NOW, t).plan).toBe('credits.free');
    expect(agentLimitsProps(credits(), null, NOW, t).plan).toBe('credits.free');
  });

  it('counts down in minutes in the last hour, and says soon once the refill is due', () => {
    const soon = agentLimitsProps(credits({ lastRefresh: '2026-09-22T12:20:00Z' }), null, NOW, t);
    expect(soon.limits[0].resets).toBe('chat.bloom.limits.resetsInMinutes{"minutes":20}');
    const due = agentLimitsProps(credits({ lastRefresh: '2026-09-22T10:00:00Z' }), null, NOW, t);
    expect(due.limits[0].resets).toBe('chat.bloom.limits.resetsSoon');
  });

  it('clamps the share and draws no limit without an allowance or before credits load', () => {
    expect(agentLimitsProps(credits({ freeCredits: 400 }), null, NOW, t).limits[0].used).toBe(0);
    expect(agentLimitsProps(credits({ freeLimit: 0 }), null, NOW, t).limits).toEqual([]);
    expect(agentLimitsProps(undefined, undefined, NOW, t)).toEqual({ plan: 'credits.free', limits: [] });
  });

  it('never invents a monthly share from the paid balance', () => {
    const { limits } = agentLimitsProps(credits({ paidCredits: 10 }), subscription('active'), NOW, t);
    expect(limits).toHaveLength(1);
  });
});
