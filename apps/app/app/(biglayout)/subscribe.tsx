import { useState, useMemo, useEffect } from 'react';
import { View, ScrollView, Pressable, useWindowDimensions } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft,
  RefreshCw,
  Sparkles,
  Search,
  Globe,
  FileSliders,
  Network,
  FlaskConical,
  Layers,
  Calendar,
  Shield,
  Building2,
  ChevronDown,
  Info,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  useSubscriptionPlans,
  useSubscription,
  useCreateSubscriptionCheckout,
  type SubscriptionPlan,
} from '@/lib/hooks/use-billing';
import { useAuth } from '@oxyhq/services';
import { toast } from '@/components/sonner';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/hooks/useTranslation';

// ─── Types ───────────────────────────────────────────────────────────

type BillingPeriod = 'monthly' | 'annual';

interface PricingFeature {
  icon: React.ElementType;
  label: string;
}

interface PricingTier {
  id: string;
  name: string;
  subtitle: string;
  monthlyPrice: number; // cents
  annualPrice: number; // cents
  features: PricingFeature[];
  isFeatured: boolean;
  ctaLabel: string;
  creditsLabel: string;
}

// ─── Feature lists (matching Manus screenshots) ─────────────────────

const FREE_FEATURES: PricingFeature[] = [
  { icon: RefreshCw, label: '300 refresh credits everyday' },
  { icon: Sparkles, label: '4,000 credits per month' },
  { icon: Search, label: 'In-depth research for everyday tasks' },
  { icon: Globe, label: 'Professional websites for standard output' },
  { icon: FileSliders, label: 'Insightful slides for regular content' },
  { icon: Network, label: 'Task scaling with Wide Research' },
  { icon: FlaskConical, label: 'Early access to beta features' },
  { icon: Layers, label: '20 concurrent tasks' },
  { icon: Calendar, label: '20 scheduled tasks' },
];

const PRO_FEATURES: PricingFeature[] = [
  { icon: RefreshCw, label: '300 refresh credits everyday' },
  { icon: Sparkles, label: '8,000 credits per month' },
  { icon: Search, label: 'In-depth research with self-set usage' },
  { icon: Globe, label: 'Professional websites for changing needs' },
  { icon: FileSliders, label: 'Insightful slides for steady creation' },
  { icon: Network, label: 'Wide Research scaled to your chosen plan' },
  { icon: FlaskConical, label: 'Early access to beta features' },
  { icon: Layers, label: '20 concurrent tasks' },
  { icon: Calendar, label: '20 scheduled tasks' },
];

const BUSINESS_FEATURES: PricingFeature[] = [
  { icon: RefreshCw, label: '300 refresh credits everyday' },
  { icon: Sparkles, label: '40,000 credits per month' },
  { icon: Search, label: 'In-depth research for large-scale tasks' },
  { icon: Globe, label: 'Professional websites with data analytics' },
  { icon: FileSliders, label: 'Insightful slides for batch production' },
  { icon: Network, label: 'Wide Research for sustained heavy use' },
  { icon: FlaskConical, label: 'Early access to beta features' },
  { icon: Layers, label: '20 concurrent tasks' },
  { icon: Calendar, label: '20 scheduled tasks' },
];

// ─── Helpers ─────────────────────────────────────────────────────────

function buildTiers(
  apiPlans: SubscriptionPlan[],
  t: (key: string) => string,
): PricingTier[] {
  const proPlan = apiPlans.find((p) => p.name === 'Pro');
  const businessPlan = apiPlans.find((p) => p.name === 'Business');

  const tiers: PricingTier[] = [
    {
      id: 'free',
      name: 'Free',
      subtitle: t('subscribe.standardUsage'),
      monthlyPrice: 0,
      annualPrice: 0,
      features: FREE_FEATURES,
      isFeatured: false,
      ctaLabel: t('subscribe.upgrade'),
      creditsLabel: '4,000 credits / month',
    },
  ];

  if (proPlan) {
    tiers.push({
      id: proPlan.id,
      name: '7-Day Free',
      subtitle: t('subscribe.customizableUsage'),
      monthlyPrice: proPlan.monthlyPrice,
      annualPrice: proPlan.annualPrice,
      features: PRO_FEATURES,
      isFeatured: true,
      ctaLabel: t('subscribe.getStartedFree'),
      creditsLabel: '8,000 credits / month',
    });
  }

  if (businessPlan) {
    tiers.push({
      id: businessPlan.id,
      name: '',
      subtitle: t('subscribe.extendedUsage'),
      monthlyPrice: businessPlan.monthlyPrice,
      annualPrice: businessPlan.annualPrice,
      features: BUSINESS_FEATURES,
      isFeatured: false,
      ctaLabel: t('subscribe.upgrade'),
      creditsLabel: '40,000 credits / month',
    });
  }

  return tiers;
}

function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(0)}`;
}

// ─── BillingToggle ───────────────────────────────────────────────────

function BillingToggle({
  value,
  onChange,
  t,
}: {
  value: BillingPeriod;
  onChange: (v: BillingPeriod) => void;
  t: (key: string) => string;
}) {
  return (
    <View className="flex-row bg-surface rounded-lg p-1">
      <Pressable
        onPress={() => onChange('monthly')}
        className={cn(
          'px-4 py-2 rounded-md',
          value === 'monthly' && 'bg-background',
        )}
      >
        <Text
          className={cn(
            'text-sm font-medium',
            value === 'monthly' ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {t('subscribe.monthly')}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onChange('annual')}
        className={cn(
          'px-4 py-2 rounded-md flex-row items-center gap-2',
          value === 'annual' && 'bg-background',
        )}
      >
        <Text
          className={cn(
            'text-sm font-medium',
            value === 'annual' ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {t('subscribe.annuallySave')}
        </Text>
      </Pressable>
    </View>
  );
}

// ─── PricingCard ─────────────────────────────────────────────────────

function PricingCard({
  tier,
  billingPeriod,
  isCurrentPlan,
  onSubscribe,
  isLoading,
  t,
}: {
  tier: PricingTier;
  billingPeriod: BillingPeriod;
  isCurrentPlan: boolean;
  onSubscribe: (planId: string) => void;
  isLoading: boolean;
  t: (key: string) => string;
}) {
  const price =
    billingPeriod === 'annual'
      ? Math.round(tier.annualPrice / 12)
      : tier.monthlyPrice;

  return (
    <Card
      className={cn(
        'flex-1 overflow-hidden',
        tier.isFeatured && 'border-primary border-2',
      )}
    >
      <CardContent className="p-6 gap-5">
        {/* Price section */}
        <View className="gap-1">
          {tier.monthlyPrice === 0 ? (
            <View className="flex-row items-baseline gap-1">
              <Text className="text-4xl font-bold text-foreground">Free</Text>
            </View>
          ) : tier.isFeatured ? (
            <View className="gap-1">
              <Text className="text-2xl font-bold text-foreground">
                {tier.name}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {billingPeriod === 'annual'
                  ? `${formatPrice(price)} ${t('subscribe.perMonthBilledYearly')}`
                  : `${t('subscribe.then')} ${formatPrice(tier.monthlyPrice)} ${t('subscribe.perMonth')}`}
              </Text>
            </View>
          ) : (
            <View className="gap-1">
              <View className="flex-row items-baseline gap-1">
                <Text className="text-4xl font-bold text-foreground">
                  {formatPrice(price)}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  {billingPeriod === 'annual'
                    ? t('subscribe.perMonthBilledYearly')
                    : t('subscribe.perMonth')}
                </Text>
              </View>
            </View>
          )}
          <Text className="text-sm text-muted-foreground mt-1">
            {tier.subtitle}
          </Text>
        </View>

        {/* CTA Button */}
        <Button
          variant={tier.isFeatured ? 'default' : 'outline'}
          size="lg"
          className={cn('w-full', tier.isFeatured && 'bg-[#2563eb]')}
          onPress={() => {
            if (tier.id === 'free') return;
            onSubscribe(tier.id);
          }}
          disabled={isCurrentPlan || tier.id === 'free' || isLoading}
          isLoading={isLoading}
        >
          <Text
            className={cn(
              'text-sm font-semibold',
              tier.isFeatured ? 'text-white' : 'text-foreground',
            )}
          >
            {isCurrentPlan ? t('subscribe.currentPlan') : tier.ctaLabel}
          </Text>
        </Button>

        {/* Credits selector (for featured tier) */}
        {tier.isFeatured && (
          <View className="flex-row items-center justify-between bg-surface rounded-lg px-4 py-3">
            <Text className="text-sm text-foreground">
              {tier.creditsLabel}
            </Text>
            <View className="flex-row items-center gap-1 bg-primary/20 px-2.5 py-1 rounded-full">
              <Text className="text-xs font-medium text-primary">
                {t('subscribe.freeTrial')}
              </Text>
              <ChevronDown size={12} className="text-primary" />
            </View>
          </View>
        )}

        {/* Feature list */}
        <View className="gap-3.5">
          {tier.features.map((feature, i) => (
            <View key={i} className="flex-row items-center gap-3">
              <feature.icon size={16} className="text-muted-foreground" />
              <Text className="text-sm text-foreground flex-1">
                {feature.label}
              </Text>
              <Info size={14} className="text-muted-foreground opacity-40" />
            </View>
          ))}
        </View>
      </CardContent>
    </Card>
  );
}

// ─── Bottom Banners ──────────────────────────────────────────────────

function TeamBanner({ t }: { t: (key: string) => string }) {
  return (
    <View className="mx-4 mt-8 p-5 rounded-2xl bg-surface border border-border flex-row items-center justify-between">
      <View className="flex-row items-center gap-3 flex-1">
        <Building2 size={24} className="text-foreground" />
        <View className="flex-1">
          <Text className="text-base font-semibold text-foreground">
            {t('subscribe.teamTitle')}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {t('subscribe.teamDescription')}
          </Text>
        </View>
      </View>
      <Button variant="outline" size="default">
        <Text className="text-sm font-medium text-foreground">
          {t('subscribe.getTeam')}
        </Text>
      </Button>
    </View>
  );
}

function SecurityBanner({ t }: { t: (key: string) => string }) {
  return (
    <View className="mx-4 mt-4 mb-8 p-5 rounded-2xl bg-surface border border-border flex-row items-center justify-between">
      <View className="flex-row items-center gap-3 flex-1">
        <Shield size={24} className="text-foreground" />
        <View className="flex-1">
          <Text className="text-base font-semibold text-foreground">
            {t('subscribe.securityTitle')}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {t('subscribe.securityDescription')}
          </Text>
        </View>
      </View>
      <Button variant="outline" size="default">
        <Text className="text-sm font-medium text-foreground">
          {t('subscribe.learnMore')}
        </Text>
      </Button>
    </View>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────

function PageFooter({ t }: { t: (key: string) => string }) {
  const router = useRouter();

  return (
    <View className="flex-row items-center justify-between px-6 py-4">
      <Text className="text-sm text-muted-foreground">
        {t('subscribe.helpText')}{' '}
        <Text className="text-sm text-foreground underline">
          {t('subscribe.helpCenter')}
        </Text>
        .
      </Text>
      <Pressable onPress={() => router.push('/(app)/billing' as any)}>
        <Text className="text-sm text-muted-foreground">
          {t('subscribe.editBilling')} &rsaquo;
        </Text>
      </Pressable>
    </View>
  );
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

  const { data: apiPlans = [] } = useSubscriptionPlans();
  const { data: subscription, refetch: refetchSubscription } =
    useSubscription();
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
          <Pressable
            onPress={() => router.back()}
            className="flex-row items-center mb-6"
          >
            <ArrowLeft size={16} className="text-muted-foreground mr-2" />
            <Text className="text-sm text-muted-foreground">
              {t('subscribe.back')}
            </Text>
          </Pressable>

          <View className="items-center gap-4 mb-8">
            <Text className="text-3xl font-bold text-foreground">
              {t('subscribe.title')}
            </Text>
            <BillingToggle
              value={billingPeriod}
              onChange={setBillingPeriod}
              t={t}
            />
          </View>
        </View>

        {/* Pricing Cards */}
        <View
          className={cn(
            'px-4 gap-4',
            isWideLayout ? 'flex-row' : 'flex-col',
          )}
        >
          {tiers.map((tier) => (
            <PricingCard
              key={tier.id}
              tier={tier}
              billingPeriod={billingPeriod}
              isCurrentPlan={
                tier.id === 'free'
                  ? !subscription || subscription.status !== 'active'
                  : subscription?.plan?.name === tier.name && subscription?.status === 'active'
              }
              onSubscribe={handleSubscribe}
              isLoading={checkoutMutation.isPending}
              t={t}
            />
          ))}
        </View>

        {/* Bottom Banners */}
        <TeamBanner t={t} />
        <SecurityBanner t={t} />
        <PageFooter t={t} />
      </View>
    </ScrollView>
  );
}
