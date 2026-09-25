import { describe, expect, it } from 'vitest';

import type { Subscription } from '@/features/billing/runtime/use-billing';
import type { CreditsInfo } from '@/features/billing/runtime/use-credits';

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

describe('the plan usage window', () => {
  it('comes first, as the share of the window spent and when its oldest spend ages out', () => {
    const { limits } = agentLimitsProps(
      credits({ window: { hours: 5, used: 250, limit: 1000, resetsAt: '2026-09-23T13:30:00Z' } }),
      subscription('active'),
      NOW,
      t,
    );
    expect(limits[0]).toEqual({
      label: 'chat.bloom.limits.window{"hours":5}',
      used: 0.25,
      resets: 'chat.bloom.limits.resetsInHours{"hours":1,"minutes":30}',
    });
    expect(limits[1].label).toBe('chat.bloom.limits.dailyFree');
  });

  it('says when a fresh window starts when nothing is spent, and clamps an overspent one', () => {
    const fresh = agentLimitsProps(credits({ window: { hours: 5, used: 0, limit: 1000, resetsAt: null } }), null, NOW, t);
    expect(fresh.limits[0].resets).toBe('chat.bloom.limits.windowFresh{"hours":5}');
    const over = agentLimitsProps(credits({ window: { hours: 5, used: 1400, limit: 1000, resetsAt: '2026-09-23T12:10:00Z' } }), null, NOW, t);
    expect(over.limits[0].used).toBe(1);
  });

  it('draws no window bar for a plan without one, or an API older than the window', () => {
    expect(agentLimitsProps(credits({ window: null }), null, NOW, t).limits).toHaveLength(1);
    expect(agentLimitsProps(credits(), null, NOW, t).limits).toHaveLength(1);
  });
});
