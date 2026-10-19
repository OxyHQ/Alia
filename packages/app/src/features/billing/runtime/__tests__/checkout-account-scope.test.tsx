import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: { user: { id: 'payer-one' }, activeSessionId: 'session-one', isAuthenticated: true },
  get: vi.fn(),
  checkout: vi.fn(),
  getKey: vi.fn(),
  clearKey: vi.fn(),
  auth: vi.fn((_services: unknown, _session: unknown, run: () => unknown) => run()),
}));
const oxy = vi.hoisted(() => ({
  useOxy: () => ({
    ...mocks.session,
    oxyServices: { billing: { startProductPlanCheckout: mocks.checkout } },
  }),
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: oxy.useOxy,
  useDisplayCurrency: () => ({ currency: 'EUR' }),
}));
vi.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (...args: [unknown, unknown, () => unknown]) => mocks.auth(...args),
}));
vi.mock('@/shared/api/client', () => ({
  default: { get: (...args: unknown[]) => mocks.get(...args) },
}));
vi.mock('@/shared/api/create-query', () => ({ useAuthQuery: vi.fn() }));
vi.mock('../product-checkout', () => ({
  productCheckoutStorageKey: (...args: string[]) => args.join(':'),
  getProductCheckoutKey: (...args: unknown[]) => mocks.getKey(...args),
  clearProductCheckoutKey: (...args: unknown[]) => mocks.clearKey(...args),
}));
const { useCreateSubscriptionCheckout } = await import('../use-billing');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | null = null;
let client: QueryClient;
let checkout: ReturnType<typeof useCreateSubscriptionCheckout>;
function Probe() {
  checkout = useCreateSubscriptionCheckout();
  return null;
}
function element() {
  return (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const config = {
  data: {
    productId: 'alia',
    plans: [{ planId: 'pro', billingPeriod: 'monthly', offerId: 'alia-pro', offerVersion: 1 }],
  },
};
const pending = { state: 'pending', checkoutUrl: 'https://checkout.peable.to/c/old' };
beforeEach(() => {
  Object.assign(mocks.session, {
    user: { id: 'payer-one' },
    activeSessionId: 'session-one',
    isAuthenticated: true,
  });
  mocks.get.mockReset().mockResolvedValue(config);
  mocks.checkout.mockReset().mockResolvedValue(pending);
  mocks.getKey.mockReset().mockResolvedValue('same-recovery-key');
  mocks.clearKey.mockReset();
  mocks.auth.mockReset().mockImplementation((_services, _session, run) => run());
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  client.clear();
});
it.each(['config', 'key', 'auth', 'response'])(
  'rejects stale checkout after %s awaits, including account switch away and back',
  async (stage) => {
    const wait = deferred<unknown>();
    if (stage === 'config') mocks.get.mockReturnValueOnce(wait.promise);
    if (stage === 'key') mocks.getKey.mockReturnValueOnce(wait.promise);
    if (stage === 'auth')
      mocks.auth.mockImplementationOnce(async (_svc, _sid, run) => {
        await wait.promise;
        return run();
      });
    if (stage === 'response') mocks.checkout.mockReturnValueOnce(wait.promise);
    act(() => {
      renderer = create(element());
    });
    let result!: Promise<unknown>;
    await act(async () => {
      result = checkout
        .mutateAsync({ planId: 'pro', billingPeriod: 'monthly' })
        .catch((error) => error);
    });
    mocks.session.user = { id: 'payer-two' };
    mocks.session.activeSessionId = 'session-two';
    act(() => renderer?.update(element()));
    mocks.session.user = { id: 'payer-one' };
    mocks.session.activeSessionId = 'session-one';
    act(() => renderer?.update(element()));
    await act(async () =>
      wait.resolve(stage === 'config' ? config : stage === 'key' ? 'same-recovery-key' : pending),
    );
    expect(await result).toMatchObject({ message: 'Account changed' });
    expect(mocks.checkout).toHaveBeenCalledTimes(stage === 'response' ? 1 : 0);
    expect(mocks.clearKey).not.toHaveBeenCalled();
  },
);
it('retains the old account recovery key on a fulfilled response after unmount', async () => {
  const wait = deferred<unknown>();
  mocks.checkout.mockReturnValueOnce(wait.promise);
  act(() => {
    renderer = create(element());
  });
  let result!: Promise<unknown>;
  await act(async () => {
    result = checkout
      .mutateAsync({ planId: 'pro', billingPeriod: 'monthly' })
      .catch((error) => error);
  });
  act(() => renderer?.unmount());
  renderer = null;
  await act(async () => wait.resolve({ state: 'fulfilled' }));
  expect(await result).toMatchObject({ message: 'Account changed' });
  expect(mocks.clearKey).not.toHaveBeenCalled();
});
it('returns a display-only checkout URL while the originating session remains active', async () => {
  act(() => {
    renderer = create(element());
  });
  let result: unknown;
  await act(async () => {
    result = await checkout.mutateAsync({ planId: 'pro', billingPeriod: 'monthly' });
  });
  expect(result).toEqual({
    state: 'pending',
    url: 'https://checkout.peable.to/c/old?displayCurrency=EUR',
  });
  expect(mocks.checkout).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedSubjectAccountId: 'payer-one',
      idempotencyKey: 'same-recovery-key',
    }),
  );
});
