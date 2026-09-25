import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The warnings that come before a turn fails for credits, back as Bloom
 * toasts after the template adoption removed the banners that carried them.
 *
 * Both read the person's own numbers — the balance from `/credits`, the
 * spending warning the server puts on their own turn's usage frame — and are
 * never raised from an error (#608 §8).
 */

const env = vi.hoisted(() => ({
  credits: undefined as undefined | { credits: number },
  userId: 'u1' as string | null,
  pushed: [] as string[],
}));
const toastFn = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('@oxy.so/bloom/toast', () => ({ toast: toastFn }));
vi.mock('@oxy.so/services', () => ({
  useOxy: () => ({ user: env.userId === null ? null : { id: env.userId } }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: (href: string) => env.pushed.push(href) }) }));
vi.mock('@/features/billing/runtime/use-credits', () => ({ useCredits: () => ({ data: env.credits }) }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
  }),
}));

import {
  LOW_CREDITS_TOAST_ID,
  resetCreditWarnings,
  USAGE_WARNING_TOAST_ID,
  useCreditWarnings,
} from '@/features/chat/runtime/use-credit-warnings';
import { queryKeys } from '@/shared/api/query-keys';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let client: QueryClient;
const renderers: ReactTestRenderer[] = [];

function Probe({ enabled }: { enabled: boolean }) {
  useCreditWarnings(enabled);
  return null;
}

async function mount(enabled = true): Promise<ReactTestRenderer> {
  let r: ReactTestRenderer | null = null;
  await act(async () => {
    r = create(
      <QueryClientProvider client={client}>
        <Probe enabled={enabled} />
      </QueryClientProvider>,
    );
  });
  renderers.push(r!);
  return r!;
}

beforeEach(() => {
  client = new QueryClient();
  env.credits = undefined;
  env.userId = 'u1';
  env.pushed = [];
  toastFn.warning.mockClear();
  toastFn.error.mockClear();
  toastFn.dismiss.mockClear();
  resetCreditWarnings();
});

afterEach(async () => {
  for (const r of renderers.splice(0)) await act(async () => r.unmount());
});

describe('the low-balance warning', () => {
  it('says so under 50 credits, once per account, with the way to buy more', async () => {
    env.credits = { credits: 12 };
    await mount();
    expect(toastFn.warning).toHaveBeenCalledOnce();
    const [message, options] = toastFn.warning.mock.calls[0];
    expect(message).toBe('usageLimit.creditsRemaining:{"count":12}');
    expect(options).toMatchObject({ id: LOW_CREDITS_TOAST_ID, action: { label: 'usageLimit.buyMore' } });
    options.action.onClick();
    expect(env.pushed).toEqual(['/(app)/settings/usage']);

    // Every visited chat stays mounted; none of them says it again.
    await mount();
    expect(toastFn.warning).toHaveBeenCalledOnce();

    // Another account is told about its own balance.
    env.userId = 'u2';
    await mount();
    expect(toastFn.warning).toHaveBeenCalledTimes(2);
  });

  it('says nothing with plenty left, with none left (that is the failure dialog), or over the welcome', async () => {
    env.credits = { credits: 500 };
    await mount();
    env.credits = { credits: 0 };
    await mount();
    env.credits = { credits: 10 };
    await mount(false);
    expect(toastFn.warning).not.toHaveBeenCalled();
  });
});

describe('the spending warning', () => {
  const warn = (level: 'warning' | 'critical', daysRemaining: number) =>
    act(async () => {
      client.setQueryData(queryKeys.credits.usageWarning, {
        level,
        daysRemaining,
        todaySpend: 40,
        avgDailySpend: 10,
      });
      // React Query notifies its observers on the next macrotask.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it('shows the server’s warning once, then consumes it', async () => {
    await mount();
    await mount();
    await warn('warning', 3.4);
    expect(toastFn.warning).toHaveBeenCalledOnce();
    expect(toastFn.warning.mock.calls[0][0]).toBe('usageLimit.warningMessage:{"days":3}');
    expect(toastFn.warning.mock.calls[0][1]).toMatchObject({ id: USAGE_WARNING_TOAST_ID });
    expect(client.getQueryData(queryKeys.credits.usageWarning)).toBeNull();
  });

  it('is an error when critical, and plain "spending high" when the refresh covers it', async () => {
    await mount();
    await warn('critical', 1);
    expect(toastFn.error).toHaveBeenCalledWith('usageLimit.criticalMessage:{"days":1}', expect.anything());
    await warn('warning', 999);
    expect(toastFn.warning).toHaveBeenCalledWith('usageLimit.spendingHighToday', expect.anything());
  });

  it('waits while the welcome is on screen', async () => {
    const r = await mount(false);
    await warn('warning', 3);
    expect(toastFn.warning).not.toHaveBeenCalled();
    await act(async () =>
      r.update(
        <QueryClientProvider client={client}>
          <Probe enabled />
        </QueryClientProvider>,
      ),
    );
    expect(toastFn.warning).toHaveBeenCalledOnce();
  });
});
