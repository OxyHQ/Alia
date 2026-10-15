import { queryKeys } from '@/shared/api/query-keys';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useOxy } from '@oxy.so/services';

/** A browser return only requests a refresh. It does not identify a settled
 * invoice, and an existing active subscription cannot confirm a new payment. */
export function useCheckoutConfirmation({
  enabled,
  refetchSubscription,
}: {
  enabled: boolean;
  refetchSubscription: () => unknown;
}) {
  const queryClient = useQueryClient();
  const { user, activeSessionId } = useOxy();
  const refreshed = useRef<string | null>(null);
  useEffect(() => {
    const subject = `${user?.id}:${activeSessionId}`;
    if (!enabled || !user?.id || !activeSessionId || refreshed.current === subject) return;
    refreshed.current = subject;
    refetchSubscription();
    void queryClient.invalidateQueries({ queryKey: queryKeys.billing.entitlements });
  }, [enabled, user?.id, activeSessionId, refetchSubscription, queryClient]);
}
