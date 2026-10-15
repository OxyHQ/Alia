import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => ({ user: { id: 'payer-one' }, activeSessionId: 'session-one' }));
const priorPaid = vi.hoisted(() => ({ current: { status: 'active' } }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => session }));
vi.mock('../use-billing', () => ({ useSubscriptionPolling: () => ({ data: priorPaid.current }) }));
const { useCheckoutConfirmation } = await import('../use-checkout-confirmation');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | null = null;
let client: QueryClient;
const refetchSubscription = vi.fn();
const paidSuccess = vi.fn();
function Probe({ enabled }: { enabled: boolean }) {
  // Deliberately inject the retired callback: a forged redirect and pre-existing
  // paid subscription must not announce a different purchase as settled.
  useCheckoutConfirmation({ enabled, refetchSubscription, ...{ onConfirmed: paidSuccess } });
  return null;
}
function element(enabled: boolean) {
  return (
    <QueryClientProvider client={client}>
      <Probe enabled={enabled} />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  refetchSubscription.mockReset();
  paidSuccess.mockReset();
  client = new QueryClient();
  session.user.id = 'payer-one';
  session.activeSessionId = 'session-one';
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  client.clear();
  vi.useRealTimers();
});
it('only refreshes a forged success redirect, even with prior paid access and after timeout', () => {
  act(() => {
    renderer = create(element(true));
  });
  expect(refetchSubscription).toHaveBeenCalledTimes(1);
  act(() => {
    vi.advanceTimersByTime(120000);
    renderer?.update(element(true));
  });
  expect(paidSuccess).not.toHaveBeenCalled();
  expect(refetchSubscription).toHaveBeenCalledTimes(1);
});
it('scopes refresh to account and session changes and never reuses a payment confirmation', () => {
  act(() => {
    renderer = create(element(true));
  });
  session.user.id = 'payer-two';
  session.activeSessionId = 'session-two';
  act(() => renderer?.update(element(true)));
  expect(refetchSubscription).toHaveBeenCalledTimes(2);
  expect(paidSuccess).not.toHaveBeenCalled();
});
it('does nothing without an explicit return refresh', () => {
  act(() => {
    renderer = create(element(false));
    vi.advanceTimersByTime(60000);
  });
  expect(refetchSubscription).not.toHaveBeenCalled();
  expect(paidSuccess).not.toHaveBeenCalled();
});
