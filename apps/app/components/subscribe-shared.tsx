import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { ArrowLeft, ChevronLeft, ChevronRight, Shield, Building2, Check } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────

export type BillingPeriod = 'monthly' | 'annual';

export interface PricingTier {
  id: string;
  name: string;
  subtitle: string;
  monthlyPrice: number; // cents
  annualPrice: number; // cents
  features: string[];
  isFeatured: boolean;
  creditsLabel: string;
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

// ─── PlanColumn ──────────────────────────────────────────────────────

export function PlanColumn({
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
    <View
      className={cn(
        'flex-1 py-5 px-4 gap-3',
        tier.isFeatured && 'bg-primary/5 rounded-2xl',
      )}
    >
      {/* Plan name + badge */}
      <View className="flex-row items-center gap-2">
        <Text className="text-lg font-bold text-foreground">{tier.name}</Text>
        {tier.isFeatured && (
          <View className="bg-primary px-2 py-0.5 rounded-full">
            <Text className="text-[10px] font-semibold text-primary-foreground">
              Popular
            </Text>
          </View>
        )}
      </View>

      {/* Subtitle */}
      <Text className="text-xs text-muted-foreground">{tier.subtitle}</Text>

      {/* Price */}
      {tier.monthlyPrice === 0 ? (
        <View className="gap-1">
          <Text className="text-3xl font-bold text-foreground">Free</Text>
          <Text className="text-sm text-muted-foreground">{tier.creditsLabel}</Text>
        </View>
      ) : (
        <View className="gap-1">
          <View className="flex-row items-center gap-1">
            <SlotPrice cents={price} />
            <Text className="text-sm text-muted-foreground">
              {t('subscribe.perMonth')}
            </Text>
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

      {/* CTA Button */}
      <Button
        variant={tier.isFeatured ? 'default' : 'outline'}
        size="sm"
        className="w-full"
        onPress={() => {
          if (tier.id === 'free') return;
          onSubscribe(tier.id);
        }}
        disabled={isCurrentPlan || tier.id === 'free' || isLoading}
        isLoading={isLoading}
      >
        <Text
          className={cn(
            'text-sm font-medium',
            tier.isFeatured ? 'text-primary-foreground' : 'text-foreground',
          )}
        >
          {isCurrentPlan ? t('subscribe.currentPlan') : t('subscribe.upgrade')}
        </Text>
      </Button>

      {/* Feature list */}
      <View className="gap-2.5 mt-2">
        {tier.features.map((feature, i) => (
          <View key={i} className="flex-row items-start gap-2">
            <Check size={16} className="text-primary mt-0.5 shrink-0" />
            <Text className="text-sm text-muted-foreground flex-1">{feature}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── PlanGrid ────────────────────────────────────────────────────────

const CARD_WIDTH = 260;
const SNAP_WIDTH = CARD_WIDTH + 1;

export function PlanGrid({
  tiers,
  billingPeriod,
  currentPlanName,
  hasActiveSubscription,
  onSubscribe,
  isLoading,
  isWideLayout,
  t,
}: {
  tiers: PricingTier[];
  billingPeriod: BillingPeriod;
  currentPlanName?: string;
  hasActiveSubscription: boolean;
  onSubscribe: (planId: string) => void;
  isLoading: boolean;
  isWideLayout: boolean;
  t: (key: string) => string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const scrollToIndex = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, tiers.length - 1));
      scrollRef.current?.scrollTo({ x: clamped * SNAP_WIDTH, animated: true });
      setActiveIndex(clamped);
    },
    [tiers.length],
  );

  const renderPlanColumn = (tier: PricingTier) => (
    <PlanColumn
      tier={tier}
      billingPeriod={billingPeriod}
      isCurrentPlan={
        tier.id === 'free'
          ? !hasActiveSubscription
          : currentPlanName === tier.name
      }
      onSubscribe={onSubscribe}
      isLoading={isLoading}
      t={t}
    />
  );

  if (isWideLayout) {
    return (
      <View className="flex-row px-2">
        {tiers.map((tier, index) => (
          <React.Fragment key={tier.id}>
            {index > 0 && <Separator orientation="vertical" />}
            {renderPlanColumn(tier)}
          </React.Fragment>
        ))}
      </View>
    );
  }

  return (
    <View>
      {/* Navigation */}
      <View className="flex-row items-center justify-between px-4 mb-2">
        <Pressable
          onPress={() => scrollToIndex(activeIndex - 1)}
          disabled={activeIndex === 0}
          className={cn(
            'w-8 h-8 rounded-full bg-muted items-center justify-center',
            activeIndex === 0 && 'opacity-30',
          )}
        >
          <ChevronLeft size={18} className="text-foreground" />
        </Pressable>

        <View className="flex-row gap-1.5">
          {tiers.map((_, i) => (
            <Pressable key={i} onPress={() => scrollToIndex(i)}>
              <View
                className={cn(
                  'w-2 h-2 rounded-full',
                  i === activeIndex ? 'bg-primary' : 'bg-muted-foreground/30',
                )}
              />
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={() => scrollToIndex(activeIndex + 1)}
          disabled={activeIndex === tiers.length - 1}
          className={cn(
            'w-8 h-8 rounded-full bg-muted items-center justify-center',
            activeIndex === tiers.length - 1 && 'opacity-30',
          )}
        >
          <ChevronRight size={18} className="text-foreground" />
        </Pressable>
      </View>

      {/* Horizontal snap scroll */}
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={SNAP_WIDTH}
        decelerationRate="fast"
        className="snap-x snap-mandatory"
        contentContainerStyle={{ paddingHorizontal: 8 }}
        onMomentumScrollEnd={(e) => {
          const idx = Math.round(e.nativeEvent.contentOffset.x / SNAP_WIDTH);
          setActiveIndex(Math.max(0, Math.min(idx, tiers.length - 1)));
        }}
        onScroll={(e) => {
          const idx = Math.round(e.nativeEvent.contentOffset.x / SNAP_WIDTH);
          const clamped = Math.max(0, Math.min(idx, tiers.length - 1));
          if (clamped !== activeIndex) setActiveIndex(clamped);
        }}
        scrollEventThrottle={100}
      >
        {tiers.map((tier, index) => (
          <React.Fragment key={tier.id}>
            {index > 0 && <Separator orientation="vertical" />}
            <View className="snap-start" style={{ width: CARD_WIDTH }}>
              {renderPlanColumn(tier)}
            </View>
          </React.Fragment>
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Banners ─────────────────────────────────────────────────────────

export function TeamBanner({ t }: { t: (key: string) => string }) {
  return (
    <View className="mx-4 mt-8 p-4 rounded-xl bg-muted/50 flex-row items-center justify-between">
      <View className="flex-row items-center gap-3 flex-1">
        <Building2 size={20} className="text-foreground" />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">
            {t('subscribe.teamTitle')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('subscribe.teamDescription')}
          </Text>
        </View>
      </View>
      <Button variant="outline" size="sm">
        <Text className="text-xs font-medium text-foreground">
          {t('subscribe.getTeam')}
        </Text>
      </Button>
    </View>
  );
}

export function SecurityBanner({ t }: { t: (key: string) => string }) {
  return (
    <View className="mx-4 mt-3 mb-8 p-4 rounded-xl bg-muted/50 flex-row items-center justify-between">
      <View className="flex-row items-center gap-3 flex-1">
        <Shield size={20} className="text-foreground" />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">
            {t('subscribe.securityTitle')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('subscribe.securityDescription')}
          </Text>
        </View>
      </View>
      <Button variant="outline" size="sm">
        <Text className="text-xs font-medium text-foreground">
          {t('subscribe.learnMore')}
        </Text>
      </Button>
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
      <Pressable onPress={() => router.push('/(app)/billing' as any)}>
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
