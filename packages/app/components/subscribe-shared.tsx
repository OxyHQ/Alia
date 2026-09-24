import { Announcement } from '@oxy.so/bloom/announcement';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { RiBuilding2Line } from '@oxy.so/bloom/icons/RiBuilding2Line';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

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

type Translate = (key: string) => string;

// ─── Helpers ─────────────────────────────────────────────────────────

export function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

// ─── Header ──────────────────────────────────────────────────────────

/**
 * The page's header: Bloom's `PageHeader` with the way back. A page opened
 * straight from a link has nothing to go back to, so it goes home instead.
 */
export function SubscribeHeader({ title, t }: { title?: string; t: Translate }) {
  const router = useRouter();
  return (
    <PageHeader
      title={title}
      backLabel={t('subscribe.back')}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/(app)'))}
    />
  );
}

// ─── BillingToggle ───────────────────────────────────────────────────

export function BillingToggle({
  value,
  onChange,
  t,
}: {
  value: BillingPeriod;
  onChange: (v: BillingPeriod) => void;
  t: Translate;
}) {
  // The control sizes itself to its segments (`alignSelf: flex-start`); the
  // wrapper is what lets a centred parent centre it.
  return (
    <View>
      <SegmentedControl type="radio" label={t('subscribe.billingPeriod')} value={value} onValueChange={onChange}>
        <SegmentedControlItem value="monthly">
          <SegmentedControlItemText>{t('subscribe.monthly')}</SegmentedControlItemText>
        </SegmentedControlItem>
        <SegmentedControlItem value="annual">
          <SegmentedControlItemText>{t('subscribe.annuallySave')}</SegmentedControlItemText>
        </SegmentedControlItem>
      </SegmentedControl>
    </View>
  );
}

// ─── Slot-machine odometer ───────────────────────────────────────────

/** One digit's window: the `display-4` line (32 over 40), and each glyph's advance. */
const DIGIT_HEIGHT = 40;
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** The line box the column scrolls by; a Reanimated geometry, so a value. */
const DIGIT_LINE = { height: DIGIT_HEIGHT, lineHeight: DIGIT_HEIGHT };
/** A digit sits centred in its fixed-width window, so a narrow `1` leaves no lopsided gap. */
const DIGIT_CELL = { ...DIGIT_LINE, textAlign: 'center' as const };

function OdometerDigit({ digit }: { digit: string }) {
  const idx = DIGITS.indexOf(digit);
  const translateY = useSharedValue(-idx * DIGIT_HEIGHT);

  useEffect(() => {
    translateY.value = withTiming(-idx * DIGIT_HEIGHT, {
      duration: 350,
      easing: Easing.out(Easing.cubic),
    });
  }, [idx, translateY]);

  const columnStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View className="h-10 w-[21px] overflow-hidden">
      <Animated.View style={columnStyle}>
        {DIGITS.map((d) => (
          <Text key={d} variant="display-4-bold" style={DIGIT_CELL}>
            {d}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
}

function SlotPrice({ cents }: { cents: number }) {
  const chars = formatPrice(cents).split('');
  return (
    <View className="flex-row items-center">
      {chars.map((char, i) => {
        const isDigit = char >= '0' && char <= '9';
        const key = `${chars.length - i}-${isDigit ? 'd' : char}`;
        return isDigit ? (
          <OdometerDigit key={key} digit={char} />
        ) : (
          <Text key={key} variant="display-4-bold" style={DIGIT_LINE}>
            {char}
          </Text>
        );
      })}
    </View>
  );
}

/** The yearly total under an annual price, fading in each time the period changes. */
function AnimatedSubtext({ text, billingPeriod }: { text: string; billingPeriod: BillingPeriod }) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = 0;
    opacity.value = withTiming(1, { duration: 300, easing: Easing.out(Easing.cubic) });
  }, [billingPeriod, opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View style={animStyle}>
      <Muted>{text}</Muted>
    </Animated.View>
  );
}

// ─── PlanGrid ────────────────────────────────────────────────────────

function getButtonState(
  tier: PricingTier,
  currentPlanId: string | undefined | null,
  currentBillingPeriod: BillingPeriod | undefined,
  hasActiveSubscription: boolean,
  cancelAtPeriodEnd: boolean | undefined,
  billingPeriod: BillingPeriod,
  tiers: PricingTier[],
): { label: string; disabled: boolean } {
  if (tier.isFree) {
    if (!hasActiveSubscription)
      return { label: 'subscribe.currentPlan', disabled: true };
    return { label: 'subscribe.downgrade', disabled: false };
  }

  if (!hasActiveSubscription) {
    return { label: 'subscribe.upgrade', disabled: false };
  }

  if (currentPlanId === tier.id) {
    if (cancelAtPeriodEnd)
      return { label: 'subscribe.reactivate', disabled: false };
    if (currentBillingPeriod && currentBillingPeriod !== billingPeriod) {
      return {
        label:
          billingPeriod === 'annual'
            ? 'subscribe.switchToAnnual'
            : 'subscribe.switchToMonthly',
        disabled: false,
      };
    }
    return { label: 'subscribe.currentPlan', disabled: true };
  }

  const currentTier = tiers.find((t) => t.id === currentPlanId);
  if (currentTier && tier.sortOrder > currentTier.sortOrder) {
    return { label: 'subscribe.upgrade', disabled: false };
  }
  return { label: 'subscribe.downgrade', disabled: false };
}

interface PlanGridProps {
  tiers: PricingTier[];
  billingPeriod: BillingPeriod;
  currentPlanId?: string | null;
  currentBillingPeriod?: BillingPeriod;
  cancelAtPeriodEnd?: boolean;
  hasActiveSubscription: boolean;
  /**
   * A complimentary plan. Every tier is inert: the API refuses both a change
   * and a cancellation on one with a 400, so no button here can succeed.
   */
  isComped?: boolean;
  onSubscribe: (planId: string) => void;
  loadingPlanId?: string;
  /** A table of every tier side by side; below it, one card per tier. */
  isWideLayout: boolean;
  t: Translate;
}

/** A tier's name and, on the featured one, the "Popular" chip. */
function TierName({ tier, t }: { tier: PricingTier; t: Translate }) {
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Text variant="title-3-bold">{tier.name}</Text>
      {tier.isFeatured ? (
        <Chip size="small" variant="solid" color="primary">
          {t('subscribe.popular')}
        </Chip>
      ) : null}
    </View>
  );
}

/** Price, credits and the action — the part of a tier that is not its features. */
function TierSummary({ tier, props }: { tier: PricingTier; props: PlanGridProps }) {
  const { billingPeriod, t, isComped, loadingPlanId, onSubscribe } = props;
  const price = billingPeriod === 'annual' ? Math.round(tier.annualPrice / 12) : tier.monthlyPrice;
  const button = getButtonState(
    tier,
    props.currentPlanId,
    props.currentBillingPeriod,
    props.hasActiveSubscription,
    props.cancelAtPeriodEnd,
    billingPeriod,
    props.tiers,
  );
  return (
    <View className="w-full gap-3">
      {tier.monthlyPrice === 0 ? (
        <Text variant="display-4-bold">{t('subscribe.free')}</Text>
      ) : (
        <View className="gap-1">
          <View className="flex-row items-center gap-1">
            <SlotPrice cents={price} />
            <Muted>{t('subscribe.perMonth')}</Muted>
          </View>
          {billingPeriod === 'annual' ? (
            <AnimatedSubtext
              text={`${formatPrice(tier.annualPrice)}${t('subscribe.perYear')}`}
              billingPeriod={billingPeriod}
            />
          ) : null}
        </View>
      )}
      <Muted>{tier.creditsLabel}</Muted>
      <Button
        variant={tier.isFeatured && !button.label.includes('downgrade') ? 'primary' : 'secondary'}
        size="sm"
        className="w-full"
        onPress={() => onSubscribe(tier.id)}
        disabled={button.disabled || isComped || !!loadingPlanId}
        loading={loadingPlanId === tier.id}
      >
        {t(button.label)}
      </Button>
    </View>
  );
}

/** One feature: a check and its label, with the description under it. */
function Feature({ feature }: { feature: FeatureItem }) {
  const { colors } = useTheme();
  return (
    <View className="flex-row items-start gap-2">
      <RiCheckLine width={16} height={16} fill={colors.primary} />
      <View className="flex-1 gap-0.5">
        <Text variant="body-regular">{feature.label}</Text>
        {feature.description ? <Muted>{feature.description}</Muted> : null}
      </View>
    </View>
  );
}

export function PlanGrid(props: PlanGridProps) {
  const { tiers, isWideLayout, t } = props;
  if (tiers.length === 0) return null;

  if (!isWideLayout) {
    return (
      <View className="gap-4 px-4">
        {tiers.map((tier) => (
          <Card key={tier.id} appearance={tier.isFeatured ? 'solid' : 'outline'}>
            <CardHeader>
              <TierName tier={tier} t={t} />
              {tier.subtitle ? <CardDescription>{tier.subtitle}</CardDescription> : null}
            </CardHeader>
            <CardBody>
              <View className="gap-4">
                <TierSummary tier={tier} props={props} />
                {tier.features.map((group) => (
                  <View key={group.category} className="gap-2">
                    <CardTitle>{group.category}</CardTitle>
                    {group.items.map((feature) => (
                      <Feature key={feature.label} feature={feature} />
                    ))}
                  </View>
                ))}
              </View>
            </CardBody>
          </Card>
        ))}
      </View>
    );
  }

  // Categories in the order they first appear across the tiers.
  const categories: string[] = [];
  for (const tier of tiers) {
    for (const group of tier.features) {
      if (!categories.includes(group.category)) categories.push(group.category);
    }
  }

  const rows: React.ReactElement[] = [
    <TableRow key="summary">
      {tiers.map((tier) => (
        <TableCell key={tier.id}>
          <View className="w-full gap-3 py-2">
            {tier.subtitle ? <Muted>{tier.subtitle}</Muted> : null}
            <TierSummary tier={tier} props={props} />
          </View>
        </TableCell>
      ))}
    </TableRow>,
  ];
  for (const category of categories) {
    rows.push(
      <TableRow key={`category-${category}`}>
        {tiers.map((tier) => (
          <TableCell key={tier.id}>
            <Text variant="caption-1-semibold">{category}</Text>
          </TableCell>
        ))}
      </TableRow>,
    );
    // Features line up by position within a category, as the plans list them.
    const depth = Math.max(
      0,
      ...tiers.map((tier) => tier.features.find((g) => g.category === category)?.items.length ?? 0),
    );
    for (let index = 0; index < depth; index++) {
      rows.push(
        <TableRow key={`${category}-${index}`}>
          {tiers.map((tier) => {
            const feature = tier.features.find((g) => g.category === category)?.items[index];
            return (
              <TableCell key={tier.id}>
                {feature ? <Feature feature={feature} /> : <Muted>—</Muted>}
              </TableCell>
            );
          })}
        </TableRow>,
      );
    }
  }

  return (
    <View className="px-2">
      <Table accessibilityLabel={t('subscribe.title')}>
        <TableHeader>
          {tiers.map((tier) => (
            <TableColumn key={tier.id} accessibilityLabel={tier.name}>
              <TierName tier={tier} t={t} />
            </TableColumn>
          ))}
        </TableHeader>
        <TableBody>{rows}</TableBody>
      </Table>
    </View>
  );
}

// ─── Banners ─────────────────────────────────────────────────────────

export function InfoBanners({ t }: { t: Translate }) {
  return (
    <View className="mx-4 my-8 flex-row flex-wrap gap-4">
      <View className="min-w-[260px] flex-1">
        <Announcement
          icon={RiBuilding2Line}
          title={t('subscribe.teamTitle')}
          description={t('subscribe.teamDescription')}
          actionLabel={t('subscribe.getTeam')}
        />
      </View>
      <View className="min-w-[260px] flex-1">
        <Announcement
          icon={RiShieldLine}
          title={t('subscribe.securityTitle')}
          description={t('subscribe.securityDescription')}
          actionLabel={t('subscribe.learnMore')}
        />
      </View>
    </View>
  );
}

export function PageFooter({ t }: { t: Translate }) {
  const router = useRouter();

  return (
    <View className="flex-row flex-wrap items-center justify-between gap-2 px-6 py-4">
      <Muted>
        {t('subscribe.helpText')} {t('subscribe.helpCenter')}.
      </Muted>
      <Button
        appearance="plain"
        tone="neutral"
        size="sm"
        onPress={() => router.push('/(app)/settings/usage')}
      >
        {`${t('subscribe.editBilling')} ›`}
      </Button>
    </View>
  );
}
