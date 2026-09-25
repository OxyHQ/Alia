import { queryKeys } from '@/shared/api/query-keys';
import { useCredits } from '@/features/billing/runtime/use-credits';
import { useTranslation } from '@/shared/i18n/use-translation';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';

/**
 * The spending warning the server attaches to a turn's usage frame
 * (`alia_usage.credit_warning`, `packages/api/src/lib/credit-anomaly.ts`):
 * today's spend is at least twice the week's daily average.
 */
export interface UsageWarning {
  level: 'warning' | 'critical';
  daysRemaining: number;
  todaySpend: number;
  avgDailySpend: number;
  currentModelMultiplier?: number;
}

/** Below this balance, and above zero, the person is told before a turn fails. */
export const LOW_CREDITS_THRESHOLD = 50;
export const LOW_CREDITS_TOAST_ID = 'low-credits';
export const USAGE_WARNING_TOAST_ID = 'usage-warning';

/**
 * The accounts already told their balance is low, this session. A module
 * value, not component state: every visited chat stays mounted, and each one
 * would otherwise tell the person again.
 */
const lowCreditsWarned = new Set<string>();

/** For tests: forget who was told. */
export function resetCreditWarnings(): void {
  lowCreditsWarned.clear();
}

/**
 * The warnings that come BEFORE a turn fails for credits — the old banners
 * above the composer, as Bloom toasts (`UsageLimitDialog` is what answers the
 * failure itself).
 *
 * Both read the person's OWN balance and spend: `/credits` and the usage frame
 * of their own turns. Nothing here reads an error. A provider's billing or
 * credential failure arrives as a stream error and is reported under the turn;
 * it never says "you are running out of credits" (#608 §8).
 *
 * - **Low balance:** fewer than 50 credits and more than none, once per
 *   account per session, with the way to buy more.
 * - **Unusual spending:** the server's warning after a turn, once per warning
 *   (it is consumed when shown). The old banner also proposed a cheaper
 *   routing profile; that suggestion is not restored, because routing
 *   profiles are being removed from the picker rather than recommended.
 *
 * `enabled` is false while the signed-out welcome owns the screen.
 */
export function useCreditWarnings(enabled: boolean): void {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useOxy();
  const userId = user?.id ?? null;
  const { data: credits } = useCredits();
  // A cache read, written by the stream: nothing is fetched for it.
  const { data: warning } = useQuery<UsageWarning | null>({
    queryKey: queryKeys.credits.usageWarning,
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const balance = credits?.credits;
  const low =
    enabled &&
    userId !== null &&
    balance !== undefined &&
    balance > 0 &&
    balance < LOW_CREDITS_THRESHOLD;

  useEffect(() => {
    if (!low || userId === null || lowCreditsWarned.has(userId)) return;
    lowCreditsWarned.add(userId);
    toast.warning(t('usageLimit.creditsRemaining', { count: balance }), {
      id: LOW_CREDITS_TOAST_ID,
      action: {
        label: t('usageLimit.buyMore'),
        onClick: () => {
          toast.dismiss(LOW_CREDITS_TOAST_ID);
          router.push('/(app)/settings/usage');
        },
      },
    });
  }, [low, userId, balance, t, router]);

  useEffect(() => {
    if (!enabled || warning === null || warning === undefined) return;
    // Another mounted chat may have shown it in this same commit.
    if (queryClient.getQueryData(queryKeys.credits.usageWarning) == null) return;
    // Consumed: the next turn's frame is the next warning.
    queryClient.setQueryData(queryKeys.credits.usageWarning, null);
    const critical = warning.level === 'critical';
    const days = Math.round(warning.daysRemaining);
    // The server says 999 when the daily refresh covers the spend.
    const message =
      days >= 999
        ? t('usageLimit.spendingHighToday')
        : critical
          ? t('usageLimit.criticalMessage', { days })
          : t('usageLimit.warningMessage', { days });
    const show = critical ? toast.error : toast.warning;
    show(message, {
      id: USAGE_WARNING_TOAST_ID,
      action: {
        label: t('usageLimit.buyMore'),
        onClick: () => {
          toast.dismiss(USAGE_WARNING_TOAST_ID);
          router.push('/(app)/settings/usage');
        },
      },
    });
  }, [enabled, warning, queryClient, t, router]);
}
