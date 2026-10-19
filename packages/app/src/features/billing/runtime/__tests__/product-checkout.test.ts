import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const rendered: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const view of rendered.splice(0)) view.unmount();
  });
});
const state = vi.hoisted(() => ({
  account: '11111111-1111-4111-8111-111111111111',
  session: 'session-a',
  storage: new Map<string, string>(),
  sequence: 0,
  get: vi.fn(),
  start: vi.fn(),
  plans: vi.fn(),
  sources: vi.fn(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => state.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      state.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      state.storage.delete(key);
    },
  },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `checkout-key-${++state.sequence}` }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => options,
  useMutation: (options: unknown) => options,
  useQueryClient: () => ({}),
}));
// One session behind both entries: the checkout reads the root entry (for the
// display currency) and its account-scope guard reads the lean entry.
const oxy = vi.hoisted(() => ({
  useOxy: () => ({
    user: { id: state.account },
    activeSessionId: state.session,
    isAuthenticated: true,
    oxyServices: {
      billing: {
        startProductPlanCheckout: state.start,
        productPlans: state.plans,
        productSubscriptions: state.sources,
      },
    },
  }),
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  useDisplayCurrency: () => ({ currency: 'EUR' }),
  useOxy: oxy.useOxy,
}));
vi.mock('@oxy.so/core', () => ({
  authenticatedApiCall: async (_api: unknown, _session: unknown, request: () => unknown) =>
    request(),
}));
vi.mock('@/shared/api/client', () => ({ default: { get: state.get } }));
vi.mock('@/shared/api/create-query', () => ({ useAuthQuery: vi.fn() }));
import { useCreateSubscriptionCheckout, useProductCheckoutOptions } from '../use-billing';
import { getProductCheckoutKey, productCheckoutStorageKey } from '../product-checkout';

beforeEach(() => {
  vi.clearAllMocks();
  state.storage.clear();
  state.account = '11111111-1111-4111-8111-111111111111';
  state.session = 'session-a';
  state.get.mockResolvedValue({
    data: {
      productId: 'alia',
      plans: [
        { planId: 'pro', offerId: 'alia-pro-year', offerVersion: 1, billingPeriod: 'annual' },
      ],
    },
  });
  state.plans.mockResolvedValue({
    purchase: 'available',
    plans: [
      {
        offerId: 'alia-pro-year',
        offerVersion: 1,
        price: { currency: 'USD', amountMinorUnits: 9590, interval: 'year' },
      },
    ],
  });
  state.sources.mockResolvedValue([]);
});
function checkout() {
  let result!: ReturnType<typeof useCreateSubscriptionCheckout>;
  function Probe() {
    result = useCreateSubscriptionCheckout();
    return null;
  }
  act(() => {
    rendered.push(create(createElement(Probe)));
  });
  return result as unknown as {
    mutationFn(input: {
      planId: string;
      billingPeriod: 'monthly' | 'annual';
    }): Promise<{ url?: string; state: string }>;
  };
}
function options() {
  let result!: ReturnType<typeof useProductCheckoutOptions>;
  function Probe() {
    result = useProductCheckoutOptions();
    return null;
  }
  act(() => {
    rendered.push(create(createElement(Probe)));
  });
  return result as unknown as {
    queryKey: unknown[];
    queryFn(): Promise<{
      available: boolean;
      plans: Array<{ price: { amountMinorUnits: number } }>;
      currentPlan: unknown;
    }>;
  };
}

it('serializes durable keys across simultaneous retries and scopes them by account, offer and cadence version', async () => {
  const key = productCheckoutStorageKey(state.account, 'alia', 'year', 1);
  const results = await Promise.all([getProductCheckoutKey(key), getProductCheckoutKey(key)]);
  expect(results[0]).toBe(results[1]);
  expect(await getProductCheckoutKey(key)).toBe(results[0]);
  expect(
    await getProductCheckoutKey(productCheckoutStorageKey('another', 'alia', 'year', 1)),
  ).not.toBe(results[0]);
});
it('uses official authenticated checkout with the same key after a lost reply, and display currency changes no authorization amount', async () => {
  state.start.mockRejectedValueOnce(new Error('lost reply')).mockResolvedValue({
    state: 'pending',
    intentId: 'intent',
    checkoutUrl: 'https://checkout.peable.to/s/actual?secret=test',
  });
  await expect(checkout().mutationFn({ planId: 'pro', billingPeriod: 'annual' })).rejects.toThrow(
    'lost reply',
  );
  const result = await checkout().mutationFn({ planId: 'pro', billingPeriod: 'annual' });
  expect(state.start.mock.calls[1][0]).toEqual(state.start.mock.calls[0][0]);
  expect(state.start.mock.calls[1][0]).toEqual({
    expectedSubjectAccountId: state.account,
    productId: 'alia',
    offerId: 'alia-pro-year',
    offerVersion: 1,
    idempotencyKey: expect.any(String),
  });
  expect(new URL(result.url ?? '').searchParams.get('displayCurrency')).toBe('EUR');
  expect(new URL(result.url ?? '').searchParams.get('secret')).toBe('test');
});
it('requires exact declared cadence and never manufactures monthly checkout from an annual binding', async () => {
  await expect(checkout().mutationFn({ planId: 'pro', billingPeriod: 'monthly' })).rejects.toThrow(
    'unavailable',
  );
  expect(state.start).not.toHaveBeenCalled();
  state.plans.mockResolvedValue({
    purchase: 'available',
    plans: [{ offerId: 'alia-pro-year', offerVersion: 1, price: { interval: 'month' } }],
  });
  expect((await options().queryFn()).plans).toEqual([]);
});
it('shows existing individual management even when a larger One allowance wins the credit maximum', async () => {
  state.sources.mockResolvedValue([
    {
      sourceId: 'source',
      status: 'active',
      offers: [{ origin: 'individual', offerId: 'alia-pro-year', offerVersion: 1 }],
    },
  ]);
  const first = options();
  const result = await first.queryFn();
  expect(result.plans[0].price.amountMinorUnits).toBe(9590);
  expect(result.currentPlan).toEqual({ planId: 'pro', sourceId: 'source' });
  state.account = '22222222-2222-4222-8222-222222222222';
  state.session = 'session-b';
  expect(options().queryKey).not.toEqual(first.queryKey);
});
it('preserves unconfigured purchase state and never turns a pending response into paid success', async () => {
  state.plans.mockResolvedValue({ purchase: 'unavailable', plans: [] });
  expect((await options().queryFn()).available).toBe(false);
  state.start.mockResolvedValue({ state: 'pending', intentId: 'intent' });
  await expect(checkout().mutationFn({ planId: 'pro', billingPeriod: 'annual' })).rejects.toThrow(
    'pending',
  );
  expect(state.storage.size).toBe(1);
});
