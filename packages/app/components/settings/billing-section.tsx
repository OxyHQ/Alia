import {
  useCancelSubscription,
  useCreateCheckout,
  useCreateCustomCheckout,
  useCreatePortalSession,
  useCreditPackages,
  useCreditPrice,
  useSubscription,
  useSubscriptionPolling,
  useTransactions,
} from '@/lib/hooks/use-billing';
import { useCredits } from '@/lib/hooks/use-credits';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button, Button as SettingsActionButton } from '@oxy.so/bloom/button';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { ExternalLink } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { errorMessage as getErrorMessage } from '../../lib/errors/error-utils';

/** Left padding that lines an icon-less row up with the rows that have one. */
const ITEM_TEXT_INSET = 44;

interface BillingSectionProps {
  success?: boolean;
}

export function BillingSection({ success }: BillingSectionProps) {
  const router = useRouter();
  const { data: creditsInfo, isLoading, refetch } = useCredits();
  const { data: subscription, refetch: refetchSubscription } =
    useSubscription();
  const { data: transactionsData, refetch: refetchTransactions } =
    useTransactions(10, 0);
  const { data: packages = [] } = useCreditPackages();
  const { data: creditPrice } = useCreditPrice();
  const cancelSubscriptionMutation = useCancelSubscription();
  const createPortalMutation = useCreatePortalSession();
  const createCheckoutMutation = useCreateCheckout();
  const createCustomCheckoutMutation = useCreateCustomCheckout();
  const [customCredits, setCustomCredits] = useState('');
  const { t } = useTranslation();
  const { colors } = useTheme();

  const toastShown = useRef(false);

  const { data: polledSubscription } = useSubscriptionPolling(undefined, {
    enabled: !!success,
  });

  // Show success toast once subscription is confirmed via polling
  useEffect(() => {
    if (!success || toastShown.current) return;

    if (
      polledSubscription &&
      (polledSubscription.status === 'active' ||
        polledSubscription.status === 'trialing')
    ) {
      toastShown.current = true;
      refetch();
      refetchSubscription();
      refetchTransactions();
      toast.success(t('billing.paymentSuccess'));
      setTimeout(() => router.replace('/(app)/settings/usage'), 100);
    }
  }, [success, polledSubscription]);

  // Timeout fallback
  useEffect(() => {
    if (!success || toastShown.current) return;

    const timeout = setTimeout(() => {
      if (!toastShown.current) {
        toastShown.current = true;
        refetch();
        refetchSubscription();
        refetchTransactions();
        toast.success(t('billing.paymentSuccess'));
        setTimeout(() => router.replace('/(app)/settings/usage'), 100);
      }
    }, 32000);
    return () => clearTimeout(timeout);
  }, [success]);

  const handleCancelSubscription = async () => {
    try {
      await cancelSubscriptionMutation.mutateAsync();
      toast.success(t('billing.cancelSubscriptionSuccess'));
    } catch (error: unknown) {
      toast.error(
        getErrorMessage(error) || t('billing.failedCancelSubscription'),
      );
    }
  };

  const handleManagePayment = async () => {
    try {
      const url = await createPortalMutation.mutateAsync(
        Linking.createURL('/settings/usage'),
      );
      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('billing.failedPortal'));
    }
  };

  const isSubscribed = subscription && subscription.status === 'active';
  const freeCredits = creditsInfo
    ? creditsInfo.credits - creditsInfo.paidCredits
    : 0;

  const handlePurchaseCredits = async (packageId: string) => {
    try {
      const { url } = await createCheckoutMutation.mutateAsync({
        packageId,
        successUrl: Linking.createURL('/settings/usage?success=true'),
        cancelUrl: Linking.createURL('/settings/usage'),
      });
      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('billing.failedCheckout'));
    }
  };

  const parsedCustomCredits = parseInt(customCredits) || 0;
  const customPriceCents = creditPrice
    ? Math.round(parsedCustomCredits * creditPrice.pricePerCreditCents)
    : 0;
  const canBuyCustom =
    creditPrice &&
    parsedCustomCredits >= creditPrice.minCredits &&
    parsedCustomCredits <= creditPrice.maxCredits &&
    customPriceCents >= 50;

  const handleCustomPurchase = async () => {
    if (!canBuyCustom) return;
    try {
      const { url } = await createCustomCheckoutMutation.mutateAsync({
        credits: parsedCustomCredits,
        successUrl: Linking.createURL('/settings/usage?success=true'),
        cancelUrl: Linking.createURL('/settings/usage'),
      });
      if (url) {
        await Linking.openURL(url);
        setCustomCredits('');
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('billing.failedCheckout'));
    }
  };

  if (isLoading) {
    return (
      <View className="py-6">
        <Text className="text-sm text-muted-foreground">
          {t('common.loading')}
        </Text>
      </View>
    );
  }

  if (!creditsInfo) {
    return (
      <View className="py-6">
        <Text className="text-sm text-muted-foreground">
          {t('billing.failedToLoad')}
        </Text>
      </View>
    );
  }

  return (
    <View>
      <SettingsSection label={t('credits.credits')}>
        <SettingsCard>
          <SettingsRow label={t('credits.freeCredits')}>
            <SettingsValueField>{`${freeCredits.toLocaleString()} / ${creditsInfo.freeLimit.toLocaleString()}`}</SettingsValueField>
          </SettingsRow>
          {creditsInfo.paidCredits > 0 ? (
            <SettingsRow label={t('credits.paidCredits')}>
              <SettingsValueField>
                {creditsInfo.paidCredits.toLocaleString()}
              </SettingsValueField>
            </SettingsRow>
          ) : null}
          {creditsInfo.dailyRefresh > 0 ? (
            <SettingsRow label={t('credits.dailyRefresh')}>
              <SettingsValueField>{`+${creditsInfo.dailyRefresh}`}</SettingsValueField>
            </SettingsRow>
          ) : null}
          {!isSubscribed ? (
            <SettingsRow label={t('credits.upgrade')}>
              <SettingsActionButton
                variant="secondary"
                size="sm"
                onPress={() => router.push('/(biglayout)/subscribe')}
              >
                {t('credits.upgrade')}
              </SettingsActionButton>
            </SettingsRow>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      {isSubscribed ? (
        <SettingsSection
          label={t('billing.activeSubscription')}
          description={
            subscription.cancelAtPeriodEnd
              ? t('billing.cancelsOn', {
                  date: new Date(
                    subscription.currentPeriodEnd,
                  ).toLocaleDateString(),
                })
              : t('billing.renewsOn', {
                  date: new Date(
                    subscription.currentPeriodEnd,
                  ).toLocaleDateString(),
                })
          }
        >
          <SettingsCard>
            <SettingsRow
              label={subscription.plan.name}
              description={t('billing.creditsPerMonth', {
                count: subscription.plan.creditsPerMonth.toLocaleString(),
              })}
            >
              <SettingsValueField>{`$${(subscription.plan.price / 100).toFixed(2)}${t('credits.perMonth')}`}</SettingsValueField>
            </SettingsRow>
            {/*
             * A complimentary plan is not billed and has no Stripe object behind
             * it, so both management actions are refused by the API with a 400.
             * They are not offered rather than offered-and-failing.
             */}
            {subscription.isComped ? null : (
              <SettingsRow label={t('billing.changePlan')}>
                <SettingsActionButton
                  variant="secondary"
                  size="sm"
                  onPress={() => router.push('/(biglayout)/subscribe')}
                >
                  {t('billing.changePlan')}
                </SettingsActionButton>
              </SettingsRow>
            )}
            {!subscription.isComped && !subscription.cancelAtPeriodEnd ? (
              <SettingsRow
                label={
                  cancelSubscriptionMutation.isPending
                    ? t('billing.canceling')
                    : t('billing.cancelSubscription')
                }
              >
                <SettingsActionButton
                  variant="secondary"
                  size="sm"
                  disabled={cancelSubscriptionMutation.isPending}
                  tone="danger"
                  onPress={handleCancelSubscription}
                >
                  {cancelSubscriptionMutation.isPending
                    ? t('billing.canceling')
                    : t('billing.cancelSubscription')}
                </SettingsActionButton>
              </SettingsRow>
            ) : null}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {packages.length > 0 ? (
        <SettingsSection label={t('credits.buyCredits')}>
          <SettingsCard>
            {packages.map((pkg) => (
              <SettingsRow
                key={pkg.id}
                label={pkg.name}
                description={t('credits.perThousand', {
                  price: `$${(((pkg.price / pkg.credits) * 1000) / 100).toFixed(2)}`,
                })}
              >
                <SettingsActionButton
                  variant="secondary"
                  size="sm"
                  disabled={createCheckoutMutation.isPending}
                  onPress={() => handlePurchaseCredits(pkg.id)}
                >
                  <SettingsValueField>{`$${(pkg.price / 100).toFixed(2)}`}</SettingsValueField>
                </SettingsActionButton>
              </SettingsRow>
            ))}
            <SettingsRow label={t('billing.customAmount')}>
              <View className="flex-row items-center gap-2">
                <TextFieldInput
                  label={t('billing.customAmountPlaceholder')}
                  value={customCredits}
                  onChangeText={(text) =>
                    setCustomCredits(text.replace(/[^0-9]/g, ''))
                  }
                  placeholder={t('billing.customAmountPlaceholder')}
                  keyboardType="number-pad"
                  className="w-28 py-1.5 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
                  placeholderTextColor={colors.textSecondary}
                />
                <Button
                  variant="secondary"
                  onPress={handleCustomPurchase}
                  disabled={
                    !canBuyCustom || createCustomCheckoutMutation.isPending
                  }
                  size="sm"
                  className="rounded-full h-8 px-3"
                  loading={createCustomCheckoutMutation.isPending}
                >
                  {customPriceCents > 0
                    ? `$${(customPriceCents / 100).toFixed(2)}`
                    : t('billing.buy')}
                </Button>
              </View>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection label={t('billing.paymentMethods')}>
        <SettingsCard>
          <SettingsRow
            label={
              createPortalMutation.isPending
                ? t('common.loading')
                : t('billing.managePaymentMethods')
            }
          >
            <SettingsActionButton
              variant="secondary"
              size="sm"
              disabled={createPortalMutation.isPending}
              onPress={handleManagePayment}
            >
              <ExternalLink size={14} color={colors.textTertiary} />
            </SettingsActionButton>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {transactionsData && transactionsData.transactions.length > 0 ? (
        <SettingsSection label={t('billing.recentTransactions')}>
          <SettingsCard>
            {transactionsData.transactions.map((transaction) => (
              <SettingsRow
                key={transaction._id}
                label={transaction.description || transaction.type}
                description={`${new Date(transaction.createdAt).toLocaleDateString()} · $${(transaction.amount / 100).toFixed(2)}`}
              >
                <SettingsValueField>{`+${transaction.credits.toLocaleString()}`}</SettingsValueField>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </View>
  );
}
