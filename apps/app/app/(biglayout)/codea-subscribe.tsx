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
  PageFooter,
} from '@/components/subscribe-shared';

// ─── Codea feature lists ─────────────────────────────────────────────

const CODEA_FEATURES: Record<string, string[]> = {
  'codea-pro': [
    '10,000 credits per month',
    '300 daily refresh credits',
    'AI code completions',
    'Chat-based code assistance',
    'Multi-file editing',
    'All standard models',
  ],
  'codea-max': [
    '50,000 credits per month',
    '300 daily refresh credits',
    'Priority model access',
    'Extended context windows',
    'Advanced code analysis',
    'Dedicated capacity',
  ],
};

const CODEA_CONFIG: Record<string, { subtitle: string; isFeatured: boolean }> = {
  'codea-pro': { subtitle: 'subscribe.codeaProUsage', isFeatured: false },
  'codea-max': { subtitle: 'subscribe.codeaMaxUsage', isFeatured: true },
};

function buildCodeaTiers(
  apiPlans: SubscriptionPlan[],
  t: (key: string) => string,
): PricingTier[] {
  const tiers: PricingTier[] = [];

  for (const plan of apiPlans) {
    const config = CODEA_CONFIG[plan.id];
    if (!config) continue;
    tiers.push({
      id: plan.id,
      name: plan.name,
      subtitle: t(config.subtitle),
      monthlyPrice: plan.monthlyPrice,
      annualPrice: plan.annualPrice,
      features: CODEA_FEATURES[plan.id] || CODEA_FEATURES['codea-pro'],
      isFeatured: config.isFeatured,
      creditsLabel: `${plan.creditsPerMonth.toLocaleString()} credits / mo`,
    });
  }

  return tiers;
}

// ─── Main Screen ─────────────────────────────────────────────────────

export default function CodeaSubscribeScreen() {
  const router = useRouter();
  const { success } = useLocalSearchParams();
  const { isAuthenticated } = useAuth();
  const { width } = useWindowDimensions();
  const isWideLayout = width >= 600;
  const { t } = useTranslation();

  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('annual');
  const [isMounted, setIsMounted] = useState(false);

  const { data: apiPlans = [] } = useSubscriptionPlans('codea');
  const { data: subscription, refetch: refetchSubscription } =
    useSubscription('codea');
  const checkoutMutation = useCreateSubscriptionCheckout();

  const tiers = useMemo(() => buildCodeaTiers(apiPlans, t), [apiPlans, t]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (isMounted && success === 'true') {
      refetchSubscription();
      toast.success(t('subscribe.paymentSuccess'));
      setTimeout(() => {
        router.replace('/(biglayout)/codea-subscribe');
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
        successUrl: Linking.createURL('/(biglayout)/codea-subscribe?success=true'),
        cancelUrl: Linking.createURL('/(biglayout)/codea-subscribe'),
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
      <View className="w-full max-w-[800px] mx-auto">
        {/* Header */}
        <View className="px-6 pt-6 pb-2">
          <BackButton t={t} />

          <View className="items-center gap-3 mb-8">
            <Text className="text-2xl font-bold text-foreground">
              {t('subscribe.codeaTitle')}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {t('subscribe.codeaSubtitle')}
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

        {/* Shared credits note */}
        <View className="mx-4 mt-6 p-4 rounded-xl bg-muted/50 items-center">
          <Text className="text-xs text-muted-foreground text-center">
            {t('subscribe.sharedCredits')}
          </Text>
        </View>

        {/* Footer */}
        <PageFooter t={t} />
      </View>
    </ScrollView>
  );
}
