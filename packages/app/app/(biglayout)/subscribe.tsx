import {
  BillingToggle,
  InfoBanners,
  PageFooter,
  PlanGrid,
  SubscribeHeader,
  type BillingPeriod,
  type PricingTier,
} from '@/components/subscribe-shared';
import { queryKeys } from '@/lib/hooks/query-keys';
import {
  useCancelSubscription,
  useChangePlan,
  useCreateSubscriptionCheckout,
  useSubscription,
  useSubscriptionPlans,
  useSubscriptionPolling,
  type SubscriptionPlan,
} from '@/lib/hooks/use-billing';
import { useTranslation } from '@/lib/hooks/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services';
import { useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { errorMessage as getErrorMessage } from '../../lib/errors/error-utils';
function buildTiers(
  apiPlans: SubscriptionPlan[],
  t: (key: string) => string,
): PricingTier[] {
  return apiPlans.map((plan, index) => ({
    id: plan.id,
    name: plan.name,
    subtitle: plan.subtitle ? t(plan.subtitle) : '',
    monthlyPrice: plan.monthlyPrice,
    annualPrice: plan.annualPrice,
    features: (plan.features || []).map((g) => ({
      category: g.category,
      items: g.items.map((item) => ({ label: item.label, description: item.description })),
    })),
    isFeatured: plan.isFeatured || false,
    isFree: plan.isFree || false,
    creditsLabel: plan.creditsLabel || `${plan.creditsPerMonth.toLocaleString()} credits / mo`,
    sortOrder: plan.sortOrder ?? index,
  }));
}

// ─── Main Screen ─────────────────────────────────────────────────────

export default function SubscribeScreen() {
  const router = useRouter();
  const { success } = useLocalSearchParams();
  const { isAuthenticated, signIn } = useAuth();
  const { width } = useWindowDimensions();
  const isWideLayout = width >= 900;
  const { t } = useTranslation();

  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  const [loadingPlanId, setLoadingPlanId] = useState<string>();
  const [isMounted, setIsMounted] = useState(false);

  const queryClient = useQueryClient();
  const { data: apiPlans = [], isLoading: plansLoading, isError: plansError } = useSubscriptionPlans('alia');
  const { data: subscription, refetch: refetchSubscription } =
    useSubscription('alia');
  const checkoutMutation = useCreateSubscriptionCheckout();
  const changePlanMutation = useChangePlan();
  const cancelMutation = useCancelSubscription();

  const tiers = useMemo(() => buildTiers(apiPlans, t), [apiPlans, t]);

  const isPaymentSuccess = isMounted && success === 'true';
  const toastShown = useRef(false);

  const { data: polledSubscription } = useSubscriptionPolling('alia', {
    enabled: isPaymentSuccess,
  });

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Show success toast and redirect once subscription is confirmed via polling
  useEffect(() => {
    if (!isPaymentSuccess || toastShown.current) return;

    if (polledSubscription && (polledSubscription.status === 'active' || polledSubscription.status === 'trialing')) {
      toastShown.current = true;
      refetchSubscription();
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.entitlements });
      toast.success(t('subscribe.paymentSuccess'));
      setTimeout(() => router.replace('/(biglayout)/subscribe'), 100);
    }
  }, [isPaymentSuccess, polledSubscription]);

  // Timeout fallback: if polling doesn't find subscription within 30s, still show success
  useEffect(() => {
    if (!isPaymentSuccess || toastShown.current) return;

    const timeout = setTimeout(() => {
      if (!toastShown.current) {
        toastShown.current = true;
        refetchSubscription();
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.entitlements });
        toast.success(t('subscribe.paymentSuccess'));
        setTimeout(() => router.replace('/(biglayout)/subscribe'), 100);
      }
    }, 32000);
    return () => clearTimeout(timeout);
  }, [isPaymentSuccess]);

  const executePlanChange = async (planId: string) => {
    setLoadingPlanId(planId);
    try {
      const result = await changePlanMutation.mutateAsync({ planId, billingPeriod });
      await refetchSubscription();
      toast.success(t(result.direction === 'upgrade' ? 'subscribe.upgradeSuccess' : 'subscribe.downgradeSuccess'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('subscribe.failedPlanChange'));
    } finally {
      setLoadingPlanId(undefined);
    }
  };

  const handleSubscribe = async (planId: string) => {
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }

    const targetTier = tiers.find(tier => tier.id === planId);
    if (!targetTier) return;

    const hasActiveSub = subscription && (subscription.status === 'active' || subscription.status === 'trialing');

    // Downgrade to Free = cancel subscription
    if (targetTier.isFree && hasActiveSub) {
      const ok = await confirm({
        title: t('subscribe.downgradeToFreeTitle'),
        description: t('subscribe.downgradeToFreeDescription', {
          date: new Date(subscription.currentPeriodEnd).toLocaleDateString(),
        }),
        confirmLabel: t('subscribe.confirmDowngrade'),
        destructive: true,
      });
      if (ok) {
        setLoadingPlanId(planId);
        try {
          await cancelMutation.mutateAsync();
          await refetchSubscription();
          toast.success(t('subscribe.downgradeSuccess'));
        } catch (error: unknown) {
          toast.error(getErrorMessage(error) || t('subscribe.failedPlanChange'));
        } finally {
          setLoadingPlanId(undefined);
        }
      }
      return;
    }

    // Has active subscription → change plan
    if (hasActiveSub) {
      const currentTier = tiers.find(tier => tier.id === subscription.plan?.planId);
      const isDowngrade = currentTier && targetTier.sortOrder < currentTier.sortOrder;

      if (isDowngrade) {
        const ok = await confirm({
          title: t('subscribe.confirmDowngradeTitle'),
          description: t('subscribe.confirmDowngradeDescription', {
            from: currentTier?.name || subscription.plan?.name,
            to: targetTier.name,
          }),
          confirmLabel: t('subscribe.confirmDowngrade'),
        });
        if (ok) await executePlanChange(planId);
      } else {
        await executePlanChange(planId);
      }
      return;
    }

    // No subscription → Stripe Checkout
    setLoadingPlanId(planId);
    try {
      const { url } = await checkoutMutation.mutateAsync({
        planId,
        billingPeriod,
        successUrl: Linking.createURL('/(biglayout)/subscribe?success=true'),
        cancelUrl: Linking.createURL('/(biglayout)/subscribe'),
      });

      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('subscribe.failedCheckout'));
    } finally {
      setLoadingPlanId(undefined);
    }
  };

  return (
    <Screen header={<SubscribeHeader title={t('subscribe.title')} t={t} />}>
      <ScreenScrollView>
        <View className="mx-auto w-full max-w-[1200px]">
          <View className="items-center px-6 pb-8 pt-2">
            <BillingToggle value={billingPeriod} onChange={setBillingPeriod} t={t} />
          </View>

          {plansLoading && tiers.length === 0 ? (
            <View className="py-16">
              <Loading size="large" />
            </View>
          ) : plansError ? (
            <EmptyState variant="compact" icon={RiErrorWarningLine} title={t('subscribe.loadError')} />
          ) : (
            <PlanGrid
              tiers={tiers}
              billingPeriod={billingPeriod}
              currentPlanId={subscription?.plan?.planId}
              currentBillingPeriod={subscription?.plan?.billingPeriod}
              cancelAtPeriodEnd={subscription?.cancelAtPeriodEnd}
              isComped={subscription?.isComped}
              hasActiveSubscription={!!subscription && subscription.status === 'active'}
              onSubscribe={handleSubscribe}
              loadingPlanId={loadingPlanId}
              isWideLayout={isWideLayout}
              t={t}
            />
          )}

          <InfoBanners t={t} />
          <PageFooter t={t} />
        </View>
      </ScreenScrollView>
    </Screen>
  );
}
