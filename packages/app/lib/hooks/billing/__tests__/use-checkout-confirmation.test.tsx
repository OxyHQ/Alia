import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coming back from checkout confirms ONCE — by polling finding the new
 * subscription, or by the fallback when the webhook is slow — never twice,
 * and never at all on a visit that did not come from a checkout.
 */

const polled = vi.hoisted(() => ({ current: undefined as { status: string } | undefined }));

vi.mock('@/lib/hooks/use-billing', () => ({
  useSubscriptionPolling: () => ({ data: polled.current }),
}));

const { useCheckoutConfirmation } = await import('../use-checkout-confirmation');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
const onConfirmed = vi.fn();
const refetchSubscription = vi.fn();
let client: QueryClient;

function element(enabled: boolean) {
  function Probe() {
    useCheckoutConfirmation({ enabled, refetchSubscription, onConfirmed });
    return null;
  }
  return (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  polled.current = undefined;
  onConfirmed.mockReset();
  refetchSubscription.mockReset();
  client = new QueryClient();
});
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
});

describe('useCheckoutConfirmation', () => {
  it('confirms once when polling finds an active subscription, and the fallback then stays quiet', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => {
      renderer = create(element(true));
    });
    expect(onConfirmed).not.toHaveBeenCalled();

    polled.current = { status: 'active' };
    act(() => renderer?.update(element(true)));
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(refetchSubscription).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['entitlements'] });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('confirms by the fallback when polling never finds it', () => {
    polled.current = { status: 'incomplete' };
    act(() => {
      renderer = create(element(true));
    });
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a visit that did not come from a checkout', () => {
    polled.current = { status: 'active' };
    act(() => {
      renderer = create(element(false));
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(refetchSubscription).not.toHaveBeenCalled();
  });
});
