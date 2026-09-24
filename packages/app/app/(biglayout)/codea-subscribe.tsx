import {
  BillingToggle,
  PageFooter,
  PlanGrid,
  SubscribeHeader,
  type BillingPeriod,
  type PricingTier,
} from '@/components/subscribe-shared';
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
import { Card, CardBody } from '@oxy.so/bloom/card';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { errorMessage as getErrorMessage } from '../../lib/errors/error-utils';
const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function buildCodeaTiers(
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

export default function CodeaSubscribeScreen() {
  const router = useRouter();
  const { success } = useLocalSearchParams();
  const { isAuthenticated, signIn } = useAuth();
  const { width } = useWindowDimensions();
  const isWideLayout = width >= 600;
  const { t } = useTranslation();

  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  const [loadingPlanId, setLoadingPlanId] = useState<string>();
  const [isMounted, setIsMounted] = useState(false);

  const { data: apiPlans = [], isLoading: plansLoading, isError: plansError } = useSubscriptionPlans('codea');
  const { data: subscription, refetch: refetchSubscription } =
    useSubscription('codea');
  const checkoutMutation = useCreateSubscriptionCheckout();
  const changePlanMutation = useChangePlan();
  const cancelMutation = useCancelSubscription();

  const tiers = useMemo(() => buildCodeaTiers(apiPlans, t), [apiPlans, t]);

  const isPaymentSuccess = isMounted && success === 'true';
  const toastShown = useRef(false);

  const { data: polledSubscription } = useSubscriptionPolling('codea', {
    enabled: isPaymentSuccess,
  });

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isPaymentSuccess || toastShown.current) return;

    if (polledSubscription && (polledSubscription.status === 'active' || polledSubscription.status === 'trialing')) {
      toastShown.current = true;
      refetchSubscription();
      toast.success(t('subscribe.paymentSuccess'));
      setTimeout(() => router.replace('/(biglayout)/codea-subscribe'), 100);
    }
  }, [isPaymentSuccess, polledSubscription]);

  useEffect(() => {
    if (!isPaymentSuccess || toastShown.current) return;

    const timeout = setTimeout(() => {
      if (!toastShown.current) {
        toastShown.current = true;
        refetchSubscription();
        toast.success(t('subscribe.paymentSuccess'));
        setTimeout(() => router.replace('/(biglayout)/codea-subscribe'), 100);
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
        successUrl: Linking.createURL('/(biglayout)/codea-subscribe?success=true'),
        cancelUrl: Linking.createURL('/(biglayout)/codea-subscribe'),
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
    <Screen header={<SubscribeHeader t={t} />}>
      <ScreenScrollView>
        {/* ── Editor-style hero (token-driven surface) ──────────── */}
        <View className="bg-muted">
          <View className="w-full max-w-[800px] mx-auto px-6 pt-6 pb-8">
            <View className="items-center gap-5 mt-2">
              {/* Decorative code snippet — intentionally fixed-dark: it is a
                  product mockup (like a terminal screenshot), so its surface
                  and syntax token colors stay constant across light/dark. */}
              <View style={{ backgroundColor: '#1e2433' }} className="rounded-lg px-4 py-3 w-full max-w-[340px]">
                {/* Title bar dots */}
                <View className="flex-row gap-1.5 mb-3">
                  <View className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
                  <View className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
                  <View className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
                </View>
                <Text style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: 20, color: '#6b7280' }}>
                  {'// codea.config.ts'}
                </Text>
                <Text style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: 20 }}>
                  <Text style={{ color: '#c084fc' }}>export const</Text>
                  <Text style={{ color: '#e4e4e7' }}> plan = </Text>
                  <Text style={{ color: '#fbbf24' }}>{'{'}</Text>
                </Text>
                <Text style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: 20 }}>
                  <Text style={{ color: '#e4e4e7' }}>{'  model: '}</Text>
                  <Text style={{ color: '#34d399' }}>{'"unlimited"'}</Text>
                  <Text style={{ color: '#e4e4e7' }}>,</Text>
                </Text>
                <Text style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: 20 }}>
                  <Text style={{ color: '#e4e4e7' }}>{'  autocomplete: '}</Text>
                  <Text style={{ color: '#60a5fa' }}>true</Text>
                  <Text style={{ color: '#e4e4e7' }}>,</Text>
                </Text>
                <Text style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: 20 }}>
                  <Text style={{ color: '#fbbf24' }}>{'}'}</Text>
                </Text>
              </View>

              {/* Title + subtitle */}
              <Text className="text-2xl font-bold text-center text-foreground">
                {t('subscribe.codeaTitle')}
              </Text>
              <Text className="text-sm text-center max-w-[320px] text-muted-foreground">
                {t('subscribe.codeaSubtitle')}
              </Text>

              <BillingToggle
                value={billingPeriod}
                onChange={setBillingPeriod}
                t={t}
              />
            </View>
          </View>
        </View>

        {/* ── Plans + footer ──────────────────────────────────── */}
        <View className="w-full max-w-[800px] mx-auto">
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
            hasActiveSubscription={
                !!subscription && subscription.status === 'active'
              }
              onSubscribe={handleSubscribe}
              loadingPlanId={loadingPlanId}
              isWideLayout={isWideLayout}
              t={t}
            />
          )}

          {/* Shared credits note */}
          <View className="mx-4 mt-6">
            <Card appearance="subtle">
              <CardBody>
                <Muted>{t('subscribe.sharedCredits')}</Muted>
              </CardBody>
            </Card>
          </View>

          <PageFooter t={t} />
        </View>
      </ScreenScrollView>
    </Screen>
  );
}
