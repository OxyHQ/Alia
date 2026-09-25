import { queryKeys } from '@/shared/api/query-keys';
import { useSubscriptionPolling } from '@/features/billing/runtime/use-billing';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

/** How long to wait for the webhook-written subscription before confirming anyway. */
const CONFIRM_FALLBACK_MS = 32000;

/**
 * Coming back from checkout: wait for the subscription the payment created,
 * then refresh what depends on it and confirm ONCE.
 *
 * Polling is what normally finds it. The fallback confirms after ~30s even
 * when polling has not, because the payment itself succeeded — the checkout
 * only returns here on success — and the webhook can simply be slow.
 *
 * `onConfirmed` runs once per mount, whichever of the two gets there first.
 */
export function useCheckoutConfirmation({
  enabled,
  refetchSubscription,
  onConfirmed,
}: {
  /** True only when the page was reached from a successful checkout. */
  enabled: boolean;
  refetchSubscription: () => unknown;
  onConfirmed: () => void;
}) {
  const queryClient = useQueryClient();
  const confirmed = useRef(false);
  const { data: polledSubscription } = useSubscriptionPolling('alia', {
    enabled,
  });

  const confirm = () => {
    confirmed.current = true;
    refetchSubscription();
    queryClient.invalidateQueries({ queryKey: queryKeys.billing.entitlements });
    onConfirmed();
  };

  useEffect(() => {
    if (!enabled || confirmed.current) return;
    if (
      polledSubscription &&
      (polledSubscription.status === 'active' ||
        polledSubscription.status === 'trialing')
    ) {
      confirm();
    }
  }, [enabled, polledSubscription]);

  useEffect(() => {
    if (!enabled || confirmed.current) return;
    const timeout = setTimeout(() => {
      if (!confirmed.current) confirm();
    }, CONFIRM_FALLBACK_MS);
    return () => clearTimeout(timeout);
  }, [enabled]);
}
