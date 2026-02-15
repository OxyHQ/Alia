import { useState, useMemo, useEffect, useRef } from 'react';
import { View, ScrollView, useWindowDimensions, ActivityIndicator, Platform } from 'react-native';
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
  PageFooter,
} from '@/components/subscribe-shared';

const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function buildCodeaTiers(
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

export default function CodeaSubscribeScreen() {
  const router = useRouter();
  const { success } = useLocalSearchParams();
  const { isAuthenticated } = useAuth();
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
        successUrl: Linking.createURL('/(biglayout)/codea-subscribe?success=true'),
        cancelUrl: Linking.createURL('/(biglayout)/codea-subscribe'),
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
      {/* ── Dark editor-style hero ──────────────────────────────── */}
      <View className="bg-zinc-900 dark:bg-zinc-950">
        <View className="w-full max-w-[800px] mx-auto px-6 pt-6 pb-8">
          <BackButton t={t} />

          <View className="items-center gap-5 mt-2">
            {/* Decorative code snippet */}
            <View className="bg-zinc-800 rounded-lg px-4 py-3 w-full max-w-[340px]">
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
            <Text className="text-2xl font-bold text-white text-center">
              {t('subscribe.codeaTitle')}
            </Text>
            <Text className="text-sm text-zinc-400 text-center max-w-[320px]">
              {t('subscribe.codeaSubtitle')}
            </Text>

            {/* Billing toggle on dark bg */}
            <BillingToggle
              value={billingPeriod}
              onChange={setBillingPeriod}
              t={t}
            />
          </View>
        </View>
      </View>

      {/* ── Plans + footer ──────────────────────────────────────── */}
      <View className="w-full max-w-[800px] mx-auto">
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

        {/* Shared credits note */}
        <View className="mx-4 mt-6 p-4 rounded-xl bg-muted/50 items-center">
          <Text className="text-xs text-muted-foreground text-center">
            {t('subscribe.sharedCredits')}
          </Text>
        </View>

        <PageFooter t={t} />
      </View>
    </ScrollView>
  );
}
