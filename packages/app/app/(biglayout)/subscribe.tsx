import { useBillingActionScope } from '@/features/billing/runtime/use-billing-action-scope';
import { useCredits } from '@/features/billing/runtime/use-credits';
import { Button } from '@oxy.so/bloom/button';
import {
  BillingToggle,
  InfoBanners,
  PageFooter,
  PlanGrid,
  SubscribeHeader,
  type BillingPeriod,
  type PricingTier,
} from '@/features/billing/ui/subscribe-shared';
import { useCheckoutConfirmation } from '@/features/billing/runtime/use-checkout-confirmation';
import {
  useCancelSubscription,
  useChangePlan,
  useCreateSubscriptionCheckout,
  useProductCheckoutOptions,
  useSubscription,
  useSubscriptionPlans,
  type SubscriptionPlan,
} from '@/features/billing/runtime/use-billing';
import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth, useOxy } from '@oxy.so/services';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { errorMessage as getErrorMessage } from '@/shared/api/error-utils';
function buildTiers(apiPlans: SubscriptionPlan[], t: (key: string) => string): PricingTier[] {
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
  const { user, activeSessionId, isAuthenticated } = useOxy();
  return <SubscribeContent key={`${user?.id}:${activeSessionId}:${isAuthenticated}`} />;
}
function SubscribeContent() {
  const captureScope = useBillingActionScope();
  const router = useRouter();
  const { success } = useLocalSearchParams();
  const { isAuthenticated, signIn } = useAuth();
  const { width } = useWindowDimensions();
  const isWideLayout = width >= 900;
  const { t } = useTranslation();

  const checkoutOptions = useProductCheckoutOptions();
  const { data: credits } = useCredits();
  const nativePlan =
    checkoutOptions.data?.currentPlan ??
    (credits?.productAllowance?.source === 'oxy_product' &&
    Date.parse(credits.productAllowance.periodEnd) > Date.now()
      ? credits.productAllowance
      : null);
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  const [loadingPlanId, setLoadingPlanId] = useState<string>();
  const [paymentReview, setPaymentReview] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  const {
    data: apiPlans = [],
    isLoading: plansLoading,
    isError: plansError,
  } = useSubscriptionPlans('alia');
  const { data: subscription, refetch: refetchSubscription } = useSubscription('alia');
  const checkoutMutation = useCreateSubscriptionCheckout();
  const changePlanMutation = useChangePlan();
  const cancelMutation = useCancelSubscription();

  const tiers = useMemo(
    () =>
      buildTiers(
        apiPlans.map((plan) => {
          const declared = checkoutOptions.data?.plans.find(
            (item) => item.planId === plan.id && item.billingPeriod === 'monthly',
          );
          const annual = checkoutOptions.data?.plans.find(
            (item) => item.planId === plan.id && item.billingPeriod === 'annual',
          );
          return {
            ...plan,
            ...(declared
              ? { monthlyPrice: declared.price.amountMinorUnits, currency: declared.price.currency }
              : {}),
            ...(annual
              ? { annualPrice: annual.price.amountMinorUnits, currency: annual.price.currency }
              : {}),
          };
        }),
        t,
      ),
    [apiPlans, t, checkoutOptions.data],
  );

  const isPaymentSuccess = isMounted && success === 'true';

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // The return URL requests a refresh; it is not proof of payment.
  useCheckoutConfirmation({
    enabled: isPaymentSuccess,
    refetchSubscription,
  });

  const executePlanChange = async (planId: string) => {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    setLoadingPlanId(planId);
    try {
      const result = await changePlanMutation.mutateAsync({ planId, billingPeriod });
      if (!isCurrent()) return;
      await refetchSubscription();
      if (!isCurrent()) return;
      toast.success(
        t(
          result.direction === 'upgrade'
            ? 'subscribe.upgradeSuccess'
            : 'subscribe.downgradeSuccess',
        ),
      );
    } catch (error: unknown) {
      if (isCurrent()) toast.error(getErrorMessage(error) || t('subscribe.failedPlanChange'));
    } finally {
      if (isCurrent()) setLoadingPlanId(undefined);
    }
  };

  const handleSubscribe = async (planId: string) => {
    const isCurrent = captureScope();
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }

    if (!isCurrent()) return;
    const targetTier = tiers.find((tier) => tier.id === planId);
    if (!targetTier || nativePlan) return;

    const hasActiveSub =
      subscription && (subscription.status === 'active' || subscription.status === 'trialing');

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
      if (ok && isCurrent()) {
        setLoadingPlanId(planId);
        try {
          await cancelMutation.mutateAsync();
          if (!isCurrent()) return;
          await refetchSubscription();
          if (!isCurrent()) return;
          toast.success(t('subscribe.downgradeSuccess'));
        } catch (error: unknown) {
          if (isCurrent()) toast.error(getErrorMessage(error) || t('subscribe.failedPlanChange'));
        } finally {
          if (isCurrent()) setLoadingPlanId(undefined);
        }
      }
      return;
    }

    // Has active subscription → change plan
    if (hasActiveSub) {
      const currentTier = tiers.find((tier) => tier.id === subscription.plan?.planId);
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
        if (ok && isCurrent()) await executePlanChange(planId);
      } else {
        await executePlanChange(planId);
      }
      return;
    }

    // No subscription → the declared product checkout owned by Oxy and Peable
    setPaymentReview(false);
    setLoadingPlanId(planId);
    try {
      const { url } = await checkoutMutation.mutateAsync({
        planId,
        billingPeriod,
      });

      if (url && isCurrent()) {
        await Linking.openURL(url);
      }
    } catch (error: unknown) {
      if (isCurrent()) {
        const needsReview =
          error instanceof Error &&
          (error.message === 'PAYMENT_REVIEW_REQUIRED' ||
            ('code' in error && error.code === 'PAYMENT_REVIEW_REQUIRED'));
        setPaymentReview(needsReview);
        toast.error(
          needsReview
            ? t('subscribe.paymentReview')
            : getErrorMessage(error) || t('subscribe.failedCheckout'),
        );
      }
    } finally {
      if (isCurrent()) setLoadingPlanId(undefined);
    }
  };

  return (
    <Screen header={<SubscribeHeader title={t('subscribe.title')} t={t} />}>
      <ScreenScrollView>
        <View className="mx-auto w-full max-w-[1200px]">
          <View className="items-center px-6 pb-8 pt-2">
            <BillingToggle value={billingPeriod} onChange={setBillingPeriod} t={t} />
          </View>

          {paymentReview && (
            <View className="items-center gap-2 pb-6">
              <Text>{t('subscribe.paymentReview')}</Text>
              <Button onPress={() => Linking.openURL('https://peable.to')}>
                {t('subscribe.reviewPayment')}
              </Button>
            </View>
          )}
          {nativePlan && (
            <View className="items-center pb-6">
              <Button onPress={() => Linking.openURL('https://accounts.oxy.so/payments')}>
                {t('billing.manageOxySubscription')}
              </Button>
            </View>
          )}

          {plansLoading && tiers.length === 0 ? (
            <View className="py-16">
              <Loading size="lg" />
            </View>
          ) : plansError ? (
            <EmptyState
              variant="compact"
              icon={RiErrorWarningLine}
              title={t('subscribe.loadError')}
            />
          ) : (
            <PlanGrid
              canCheckout={(planId) =>
                // Signed out, the press is what starts sign-in; availability is
                // only known for an account.
                !isAuthenticated ||
                (checkoutOptions.data?.available === true &&
                  checkoutOptions.data.plans.some(
                    (item) => item.planId === planId && item.billingPeriod === billingPeriod,
                  ))
              }
              tiers={tiers}
              billingPeriod={billingPeriod}
              managedInOxy={!!nativePlan}
              currentPlanId={nativePlan?.planId ?? subscription?.plan?.planId}
              currentBillingPeriod={subscription?.plan?.billingPeriod}
              cancelAtPeriodEnd={subscription?.cancelAtPeriodEnd}
              isComped={subscription?.isComped}
              hasActiveSubscription={
                !!nativePlan || (!!subscription && subscription.status === 'active')
              }
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
