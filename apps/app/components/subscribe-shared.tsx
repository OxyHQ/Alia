import React, { useCallback, useEffect, useRef } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { ArrowLeft, Shield, Building2, Check } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────

export type BillingPeriod = 'monthly' | 'annual';

export interface FeatureItem {
  label: string;
  description?: string;
}

export interface FeatureGroup {
  category: string;
  items: FeatureItem[];
}

export interface PricingTier {
  id: string;
  name: string;
  subtitle: string;
  monthlyPrice: number; // cents
  annualPrice: number; // cents
  features: FeatureGroup[];
  isFeatured: boolean;
  isFree: boolean;
  creditsLabel: string;
  sortOrder: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

// ─── BillingToggle ───────────────────────────────────────────────────

export function BillingToggle({
  value,
  onChange,
  t,
}: {
  value: BillingPeriod;
  onChange: (v: BillingPeriod) => void;
  t: (key: string) => string;
}) {
  return (
    <View className="flex-row bg-muted rounded-full p-1">
      <Pressable
        onPress={() => onChange('monthly')}
        className={cn(
          'px-5 py-2 rounded-full',
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
          'px-5 py-2 rounded-full',
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

// ─── Slot-machine odometer ───────────────────────────────────────────

const DIGIT_HEIGHT = 40;
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function OdometerDigit({ digit, fontSize }: { digit: string; fontSize: number }) {
  const idx = DIGITS.indexOf(digit);
  const translateY = useSharedValue(-idx * DIGIT_HEIGHT);

  useEffect(() => {
    translateY.value = withTiming(-idx * DIGIT_HEIGHT, {
      duration: 350,
      easing: Easing.out(Easing.cubic),
    });
  }, [idx]);

  const columnStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View style={{ height: DIGIT_HEIGHT, width: fontSize * 0.65, overflow: 'hidden' }}>
      <Animated.View style={columnStyle}>
        {DIGITS.map((d) => (
          <Text
            key={d}
            className="text-foreground font-bold text-center"
            style={{ height: DIGIT_HEIGHT, lineHeight: DIGIT_HEIGHT, fontSize }}
          >
            {d}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
}

function SlotPrice({ cents, fontSize = 32 }: { cents: number; fontSize?: number }) {
  const text = formatPrice(cents);
  const chars = text.split('');

  return (
    <View className="flex-row items-center">
      {chars.map((char, i) => {
        const key = `${chars.length - i}-${char >= '0' && char <= '9' ? 'd' : char}`;
        if (char >= '0' && char <= '9') {
          return <OdometerDigit key={key} digit={char} fontSize={fontSize} />;
        }
        return (
          <Text
            key={key}
            className="text-foreground font-bold"
            style={{ height: DIGIT_HEIGHT, lineHeight: DIGIT_HEIGHT, fontSize }}
          >
            {char}
          </Text>
        );
      })}
    </View>
  );
}

// ─── Animated subtext ────────────────────────────────────────────────

function AnimatedSubtext({
  text,
  billingPeriod,
}: {
  text: string;
  billingPeriod: BillingPeriod;
}) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = 0;
    opacity.value = withTiming(1, {
      duration: 300,
      easing: Easing.out(Easing.cubic),
    });
  }, [billingPeriod]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={animStyle}>
      <Text className="text-xs text-muted-foreground">{text}</Text>
    </Animated.View>
  );
}

// ─── PlanGrid ────────────────────────────────────────────────────────

const COL_WIDTH = 220;

function getButtonState(
  tier: PricingTier,
  currentPlanId: string | undefined,
  currentBillingPeriod: BillingPeriod | undefined,
  hasActiveSubscription: boolean,
  cancelAtPeriodEnd: boolean | undefined,
  billingPeriod: BillingPeriod,
  tiers: PricingTier[],
): { label: string; disabled: boolean } {
  if (tier.isFree) {
    if (!hasActiveSubscription) return { label: 'subscribe.currentPlan', disabled: true };
    return { label: 'subscribe.downgrade', disabled: false };
  }

  if (!hasActiveSubscription) {
    return { label: 'subscribe.upgrade', disabled: false };
  }

  if (currentPlanId === tier.id) {
    if (cancelAtPeriodEnd) return { label: 'subscribe.reactivate', disabled: false };
    if (currentBillingPeriod && currentBillingPeriod !== billingPeriod) {
      return {
        label: billingPeriod === 'annual' ? 'subscribe.switchToAnnual' : 'subscribe.switchToMonthly',
        disabled: false,
      };
    }
    return { label: 'subscribe.currentPlan', disabled: true };
  }

  const currentTier = tiers.find(t => t.id === currentPlanId);
  if (currentTier && tier.sortOrder > currentTier.sortOrder) {
    return { label: 'subscribe.upgrade', disabled: false };
  }
  return { label: 'subscribe.downgrade', disabled: false };
}

export function PlanGrid({
  tiers,
  billingPeriod,
  currentPlanId,
  currentBillingPeriod,
  cancelAtPeriodEnd,
  hasActiveSubscription,
  onSubscribe,
  loadingPlanId,
  isWideLayout,
  t,
}: {
  tiers: PricingTier[];
  billingPeriod: BillingPeriod;
  currentPlanId?: string;
  currentBillingPeriod?: BillingPeriod;
  cancelAtPeriodEnd?: boolean;
  hasActiveSubscription: boolean;
  onSubscribe: (planId: string) => void;
  loadingPlanId?: string;
  isWideLayout: boolean;
  t: (key: string) => string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const snapToNearest = useCallback(
    (offsetX: number) => {
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      const idx = Math.round(offsetX / COL_WIDTH);
      const clamped = Math.max(0, Math.min(idx, tiers.length - 1));
      scrollRef.current?.scrollTo({ x: clamped * COL_WIDTH, animated: true });
    },
    [tiers.length],
  );

  const handleScroll = useCallback(
    (offsetX: number) => {
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => snapToNearest(offsetX), 80);
    },
    [snapToNearest],
  );

  if (tiers.length === 0) return null;

  // Collect unique categories in order across all tiers
  const categories: string[] = [];
  for (const tier of tiers) {
    for (const group of tier.features) {
      if (!categories.includes(group.category)) categories.push(group.category);
    }
  }

  const tableContent = (
    <View style={isWideLayout ? undefined : { width: tiers.length * COL_WIDTH }}>
      {/* Header band: name + price + button */}
      <View className="flex-row border-b border-border">
        {tiers.map((tier, i) => {
          const price = billingPeriod === 'annual' ? Math.round(tier.annualPrice / 12) : tier.monthlyPrice;
          const btnState = getButtonState(tier, currentPlanId, currentBillingPeriod, hasActiveSubscription, cancelAtPeriodEnd, billingPeriod, tiers);
          return (
            <View key={tier.id} className={cn(isWideLayout ? 'flex-1' : '', 'py-5 px-4 gap-3 border-l border-border', i === 0 && 'border-l-0', tier.isFeatured && 'bg-primary/5')} style={isWideLayout ? undefined : { width: COL_WIDTH }}>
              <View className="flex-row items-center gap-2">
                <Text className="text-lg font-bold text-foreground">{tier.name}</Text>
                {tier.isFeatured && (
                  <View className="bg-primary px-2 py-0.5 rounded-full">
                    <Text className="text-[10px] font-semibold text-primary-foreground">Popular</Text>
                  </View>
                )}
              </View>
              <Text className="text-xs text-muted-foreground">{tier.subtitle}</Text>
              {tier.monthlyPrice === 0 ? (
                <View className="gap-1">
                  <Text className="text-3xl font-bold text-foreground">Free</Text>
                  <Text className="text-sm text-muted-foreground">{tier.creditsLabel}</Text>
                </View>
              ) : (
                <View className="gap-1">
                  <View className="flex-row items-center gap-1">
                    <SlotPrice cents={price} />
                    <Text className="text-sm text-muted-foreground">{t('subscribe.perMonth')}</Text>
                  </View>
                  {billingPeriod === 'annual' && (
                    <AnimatedSubtext
                      text={`${formatPrice(tier.annualPrice)}${t('subscribe.perYear')}`}
                      billingPeriod={billingPeriod}
                    />
                  )}
                  <Text className="text-sm text-muted-foreground">{tier.creditsLabel}</Text>
                </View>
              )}
              <Button
                variant={tier.isFeatured && !btnState.label.includes('downgrade') ? 'default' : 'outline'}
                size="sm"
                className="w-full rounded-full"
                onPress={() => onSubscribe(tier.id)}
                disabled={btnState.disabled || !!loadingPlanId}
                isLoading={loadingPlanId === tier.id}
              >
                <Text className={cn('text-sm font-medium', tier.isFeatured && !btnState.label.includes('downgrade') ? 'text-primary-foreground' : 'text-foreground')}>
                  {t(btnState.label)}
                </Text>
              </Button>
            </View>
          );
        })}
      </View>

      {/* Feature rows by category */}
      {categories.map((cat) => {
        // Max number of feature items in this category across all plans
        let maxItems = 0;
        for (const tier of tiers) {
          const group = tier.features.find((g) => g.category === cat);
          if (group && group.items.length > maxItems) maxItems = group.items.length;
        }

        return (
          <React.Fragment key={cat}>
            {/* Category header row */}
            <View className="flex-row border-b border-border">
              {tiers.map((tier, i) => (
                <View key={tier.id} className={cn(isWideLayout ? 'flex-1' : '', 'py-2 px-4 border-l border-border', i === 0 && 'border-l-0', tier.isFeatured && 'bg-primary/5')} style={isWideLayout ? undefined : { width: COL_WIDTH }}>
                  <Text className="text-xs font-semibold text-foreground uppercase tracking-wider">
                    {cat}
                  </Text>
                </View>
              ))}
            </View>

            {/* Feature rows aligned by position */}
            {Array.from({ length: maxItems }, (_, rowIdx) => (
              <Pressable key={rowIdx} className="flex-row border-b border-border hover:bg-primary/10">
                {tiers.map((tier, i) => {
                  const group = tier.features.find((g) => g.category === cat);
                  const feature = group?.items[rowIdx];
                  return (
                    <View key={tier.id} className={cn(isWideLayout ? 'flex-1' : '', 'py-2.5 px-4 border-l border-border', i === 0 && 'border-l-0', tier.isFeatured && 'bg-primary/5')} style={isWideLayout ? undefined : { width: COL_WIDTH }}>
                      {feature ? (
                        <View className="flex-row items-start gap-2">
                          <Check size={14} className="text-primary mt-0.5 shrink-0" />
                          <View className="flex-1">
                            <Text className="text-sm text-muted-foreground">{feature.label}</Text>
                            {feature.description && (
                              <Text className="text-xs text-muted-foreground/70 mt-0.5">{feature.description}</Text>
                            )}
                          </View>
                        </View>
                      ) : (
                        <Text className="text-sm text-muted-foreground/30">—</Text>
                      )}
                    </View>
                  );
                })}
              </Pressable>
            ))}
          </React.Fragment>
        );
      })}
    </View>
  );

  if (isWideLayout) {
    return <View className="px-2">{tableContent}</View>;
  }

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={COL_WIDTH}
      decelerationRate="fast"
      contentContainerStyle={{ paddingHorizontal: 8 }}
      onScrollEndDrag={(e) => snapToNearest(e.nativeEvent.contentOffset.x)}
      onMomentumScrollEnd={(e) => snapToNearest(e.nativeEvent.contentOffset.x)}
      onScroll={(e) => handleScroll(e.nativeEvent.contentOffset.x)}
      scrollEventThrottle={16}
    >
      {tableContent}
    </ScrollView>
  );
}

// ─── Banners ─────────────────────────────────────────────────────────

export function InfoBanners({ t }: { t: (key: string) => string }) {
  return (
    <View className="flex-row flex-wrap gap-4 mx-4 mt-8 mb-8">
      {/* Team */}
      <View className="flex-1 min-w-[260px] p-5 rounded-2xl bg-muted/50 gap-3">
        <Building2 size={24} className="text-primary" />
        <Text className="text-base font-bold text-foreground">
          {t('subscribe.teamTitle')}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {t('subscribe.teamDescription')}
        </Text>
        <Button variant="outline" size="sm" className="rounded-full self-start mt-1">
          <Text className="text-xs font-medium text-foreground">
            {t('subscribe.getTeam')}
          </Text>
        </Button>
      </View>

      {/* Security & Compliance */}
      <View className="flex-1 min-w-[260px] p-5 rounded-2xl bg-muted/50 gap-3">
        <Shield size={24} className="text-primary" />
        <Text className="text-base font-bold text-foreground">
          {t('subscribe.securityTitle')}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {t('subscribe.securityDescription')}
        </Text>
        <Button variant="outline" size="sm" className="rounded-full self-start mt-1">
          <Text className="text-xs font-medium text-foreground">
            {t('subscribe.learnMore')}
          </Text>
        </Button>
      </View>
    </View>
  );
}

export function PageFooter({ t }: { t: (key: string) => string }) {
  const router = useRouter();

  return (
    <View className="flex-row items-center justify-between px-6 py-4">
      <Text className="text-xs text-muted-foreground">
        {t('subscribe.helpText')}{' '}
        <Text className="text-xs text-foreground underline">
          {t('subscribe.helpCenter')}
        </Text>
        .
      </Text>
      <Pressable onPress={() => router.push('/(app)/settings/usage' as any)}>
        <Text className="text-xs text-muted-foreground">
          {t('subscribe.editBilling')} &rsaquo;
        </Text>
      </Pressable>
    </View>
  );
}

export function BackButton({ t }: { t: (key: string) => string }) {
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.back()}
      className="flex-row items-center mb-6"
    >
      <ArrowLeft size={16} className="text-muted-foreground mr-2" />
      <Text className="text-sm text-muted-foreground">{t('subscribe.back')}</Text>
    </Pressable>
  );
}
