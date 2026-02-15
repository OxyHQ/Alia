import { useState, useMemo, useEffect, useRef } from 'react';
import { View, ScrollView, useWindowDimensions, ActivityIndicator } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/ui/text';
import {
  useSubscriptionPlans,
  useSubscription,
  useSubscriptionPolling,
  useCreateSubscriptionCheckout,
  type SubscriptionPlan,
} from '@/lib/hooks/use-billing';
import { useAuth } from '@oxyhq/services';
import { toast } from '@/components/sonner';
import { useTranslation } from '@/hooks/useTranslation';
import {
  type BillingPeriod,
  type PricingTier,
  BillingToggle,
  PlanGrid,
  BackButton,
  InfoBanners,
  PageFooter,
} from '@/components/subscribe-shared';

function buildTiers(
  apiPlans: SubscriptionPlan[],
  t: (key: string) => string,
): PricingTier[] {
  return apiPlans.map((plan) => ({
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
  }));
}

// ─── Main Screen ─────────────────────────────────────────────────────

export default function SubscribeScreen() {
  const router = useRouter();
  const { success } = useLocalSearchParams();
  const { isAuthenticated } = useAuth();
  const { width } = useWindowDimensions();
  const isWideLayout = width >= 900;
  const { t } = useTranslation();

  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  const [loadingPlanId, setLoadingPlanId] = useState<string>();
  const [isMounted, setIsMounted] = useState(false);

  const { data: apiPlans = [], isLoading: plansLoading, isError: plansError } = useSubscriptionPlans('alia');
  const { data: subscription, refetch: refetchSubscription } =
    useSubscription('alia');
  const checkoutMutation = useCreateSubscriptionCheckout();

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
        toast.success(t('subscribe.paymentSuccess'));
        setTimeout(() => router.replace('/(biglayout)/subscribe'), 100);
      }
    }, 32000);
    return () => clearTimeout(timeout);
  }, [isPaymentSuccess]);

  const handleSubscribe = async (planId: string) => {
    if (!isAuthenticated) {
      router.push('/login' as any);
      return;
    }

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
    } catch (error: any) {
      toast.error(error.message || t('subscribe.failedCheckout'));
    } finally {
      setLoadingPlanId(undefined);
    }
  };

  return (
    <ScrollView className="flex-1 bg-background">
      <View className="w-full max-w-[1200px] mx-auto">
        {/* Header */}
        <View className="px-6 pt-6 pb-2">
          <BackButton t={t} />

          <View className="items-center gap-4 mb-8">
            <Text className="text-2xl font-bold text-foreground">
              {t('subscribe.title')}
            </Text>
            <BillingToggle
              value={billingPeriod}
              onChange={setBillingPeriod}
              t={t}
            />
          </View>
        </View>

        {/* Pricing Grid */}
        {plansLoading && tiers.length === 0 ? (
          <View className="items-center justify-center py-16">
            <ActivityIndicator size="large" />
          </View>
        ) : plansError ? (
          <View className="items-center justify-center py-16 gap-2">
            <Text className="text-sm text-muted-foreground">{t('subscribe.loadError')}</Text>
          </View>
        ) : (
          <PlanGrid
            tiers={tiers}
            billingPeriod={billingPeriod}
            currentPlanId={subscription?.plan?.planId}
            hasActiveSubscription={
              !!subscription && subscription.status === 'active'
            }
            onSubscribe={handleSubscribe}
            loadingPlanId={loadingPlanId}
            isWideLayout={isWideLayout}
            t={t}
          />
        )}

        {/* Bottom */}
        <InfoBanners t={t} />
        <PageFooter t={t} />
      </View>
    </ScrollView>
  );
}
