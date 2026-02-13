import { useState, useMemo, useEffect } from 'react';
import { View, ScrollView, useWindowDimensions } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/ui/text';
import {
  useSubscriptionPlans,
  useSubscription,
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
  TeamBanner,
  SecurityBanner,
  PageFooter,
} from '@/components/subscribe-shared';

// ─── Feature lists (plain text) ─────────────────────────────────────

const ALIA_FEATURES: Record<string, string[]> = {
  free: [
    '300 credits refreshed daily',
    'Access to standard models',
    'Basic research and chat',
    '5 concurrent tasks',
  ],
  go: [
    '4,000 credits per month',
    '300 daily refresh credits',
    'All standard models',
    'Early access to beta features',
    '10 concurrent tasks',
  ],
  pro: [
    '10,000 credits per month',
    '300 daily refresh credits',
    'All models including premium',
    'Web search & file processing',
    '20 concurrent tasks',
  ],
  max: [
    '50,000 credits per month',
    '300 daily refresh credits',
    'Priority access to all models',
    'Extended context & output',
    'Dedicated capacity',
    '50 concurrent tasks',
  ],
  ultra: [
    '100,000 credits per month',
    '300 daily refresh credits',
    'Top priority model access',
    'Maximum context & output',
    'Dedicated heavy-workload capacity',
    '100 concurrent tasks',
  ],
};

const ALIA_CONFIG: Record<string, { subtitle: string; isFeatured: boolean }> = {
  free:  { subtitle: 'subscribe.freeUsage',  isFeatured: false },
  go:    { subtitle: 'subscribe.goUsage',    isFeatured: false },
  pro:   { subtitle: 'subscribe.proUsage',   isFeatured: true },
  max:   { subtitle: 'subscribe.maxUsage',   isFeatured: false },
  ultra: { subtitle: 'subscribe.ultraUsage', isFeatured: false },
};

function buildTiers(
  apiPlans: SubscriptionPlan[],
  t: (key: string) => string,
): PricingTier[] {
  const tiers: PricingTier[] = [
    {
      id: 'free',
      name: 'Free',
      subtitle: t('subscribe.freeUsage'),
      monthlyPrice: 0,
      annualPrice: 0,
      features: ALIA_FEATURES.free,
      isFeatured: false,
      creditsLabel: '300 credits / day',
    },
  ];

  for (const plan of apiPlans) {
    const config = ALIA_CONFIG[plan.id];
    if (!config) continue;
    tiers.push({
      id: plan.id,
      name: plan.name,
      subtitle: t(config.subtitle),
      monthlyPrice: plan.monthlyPrice,
      annualPrice: plan.annualPrice,
      features: ALIA_FEATURES[plan.id] || ALIA_FEATURES.pro,
      isFeatured: config.isFeatured,
      creditsLabel: `${plan.creditsPerMonth.toLocaleString()} credits / mo`,
    });
  }

  return tiers;
}

// ─── Main Screen ─────────────────────────────────────────────────────

export default function SubscribeScreen() {
  const router = useRouter();
  const { success } = useLocalSearchParams();
  const { isAuthenticated } = useAuth();
  const { width } = useWindowDimensions();
  const isWideLayout = width >= 900;
  const { t } = useTranslation();

  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('annual');
  const [isMounted, setIsMounted] = useState(false);

  const { data: apiPlans = [] } = useSubscriptionPlans('alia');
  const { data: subscription, refetch: refetchSubscription } =
    useSubscription('alia');
  const checkoutMutation = useCreateSubscriptionCheckout();

  const tiers = useMemo(() => buildTiers(apiPlans, t), [apiPlans, t]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (isMounted && success === 'true') {
      refetchSubscription();
      toast.success(t('subscribe.paymentSuccess'));
      setTimeout(() => {
        router.replace('/(biglayout)/subscribe');
      }, 100);
    }
  }, [isMounted, success]);

  const handleSubscribe = async (planId: string) => {
    if (!isAuthenticated) {
      router.push('/login' as any);
      return;
    }

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
        <PlanGrid
          tiers={tiers}
          billingPeriod={billingPeriod}
          currentPlanName={subscription?.plan?.name}
          hasActiveSubscription={
            !!subscription && subscription.status === 'active'
          }
          onSubscribe={handleSubscribe}
          isLoading={checkoutMutation.isPending}
          isWideLayout={isWideLayout}
          t={t}
        />

        {/* Bottom */}
        <TeamBanner t={t} />
        <SecurityBanner t={t} />
        <PageFooter t={t} />
      </View>
    </ScrollView>
  );
}
