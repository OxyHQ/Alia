import { View, TextInput } from "react-native";
import * as Linking from "expo-linking";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useRouter } from "expo-router";
import { CreditCard, ExternalLink, Sparkle, Crown, Calendar, ShoppingCart } from "lucide-react-native";
import { useCredits } from "@/lib/hooks/use-credits";
import { useSubscription, useSubscriptionPolling, useCancelSubscription, useCreatePortalSession, useTransactions, useCreditPackages, useCreateCheckout, useCreateCustomCheckout, useCreditPrice } from "@/lib/hooks/use-billing";
import { useEffect, useState, useRef } from "react";
import { toast } from "@/components/sonner";
import { useTranslation } from "@/lib/hooks/use-translation";
import { errorMessage as getErrorMessage } from '../../lib/errors/error-utils';
import { useTheme } from "@oxyhq/bloom/theme";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";

/** Left padding that lines an icon-less row up with the rows that have one. */
const ITEM_TEXT_INSET = 44;

interface BillingSectionProps {
  success?: boolean;
}

export function BillingSection({ success }: BillingSectionProps) {
  const router = useRouter();
  const { data: creditsInfo, isLoading, refetch } = useCredits();
  const { data: subscription, refetch: refetchSubscription } = useSubscription();
  const { data: transactionsData, refetch: refetchTransactions } = useTransactions(10, 0);
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

    if (polledSubscription && (polledSubscription.status === 'active' || polledSubscription.status === 'trialing')) {
      toastShown.current = true;
      refetch();
      refetchSubscription();
      refetchTransactions();
      toast.success(t('billing.paymentSuccess'));
      setTimeout(() => router.replace("/(app)/settings/usage"), 100);
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
        setTimeout(() => router.replace("/(app)/settings/usage"), 100);
      }
    }, 32000);
    return () => clearTimeout(timeout);
  }, [success]);

  const handleCancelSubscription = async () => {
    try {
      await cancelSubscriptionMutation.mutateAsync();
      toast.success(t('billing.cancelSubscriptionSuccess'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('billing.failedCancelSubscription'));
    }
  };

  const handleManagePayment = async () => {
    try {
      const url = await createPortalMutation.mutateAsync(Linking.createURL("/settings/usage"));
      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('billing.failedPortal'));
    }
  };

  const isSubscribed = subscription && subscription.status === 'active';
  const freeCredits = creditsInfo ? creditsInfo.credits - creditsInfo.paidCredits : 0;

  const handlePurchaseCredits = async (packageId: string) => {
    try {
      const { url } = await createCheckoutMutation.mutateAsync({
        packageId,
        successUrl: Linking.createURL("/settings/usage?success=true"),
        cancelUrl: Linking.createURL("/settings/usage"),
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
        successUrl: Linking.createURL("/settings/usage?success=true"),
        cancelUrl: Linking.createURL("/settings/usage"),
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
        <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
      </View>
    );
  }

  if (!creditsInfo) {
    return (
      <View className="py-6">
        <Text className="text-sm text-muted-foreground">{t('billing.failedToLoad')}</Text>
      </View>
    );
  }

  return (
    <View>
      <SettingsListGroup title={t('credits.credits')}>
        <SettingsListItem
          icon={<Sparkle size={18} color={colors.textSecondary} />}
          title={t('credits.freeCredits')}
          value={`${freeCredits.toLocaleString()} / ${creditsInfo.freeLimit.toLocaleString()}`}
        />
        {creditsInfo.paidCredits > 0 ? (
          <SettingsListItem
            title={t('credits.paidCredits')}
            value={creditsInfo.paidCredits.toLocaleString()}
            leftInset={ITEM_TEXT_INSET}
          />
        ) : null}
        {creditsInfo.dailyRefresh > 0 ? (
          <SettingsListItem
            icon={<Calendar size={18} color={colors.textSecondary} />}
            title={t('credits.dailyRefresh')}
            value={`+${creditsInfo.dailyRefresh}`}
          />
        ) : null}
        {!isSubscribed ? (
          <SettingsListItem
            title={t('credits.upgrade')}
            onPress={() => router.push("/(biglayout)/subscribe")}
            leftInset={ITEM_TEXT_INSET}
          />
        ) : null}
      </SettingsListGroup>

      {isSubscribed ? (
        <SettingsListGroup
          title={t('billing.activeSubscription')}
          footer={
            subscription.cancelAtPeriodEnd
              ? t('billing.cancelsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })
              : t('billing.renewsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })
          }
        >
          <SettingsListItem
            icon={<Crown size={18} color={colors.textSecondary} />}
            title={subscription.plan.name}
            description={t('billing.creditsPerMonth', { count: subscription.plan.creditsPerMonth.toLocaleString() })}
            value={`$${(subscription.plan.price / 100).toFixed(2)}${t('credits.perMonth')}`}
          />
          <SettingsListItem
            title={t('billing.changePlan')}
            onPress={() => router.push("/(biglayout)/subscribe")}
            leftInset={ITEM_TEXT_INSET}
          />
          {!subscription.cancelAtPeriodEnd ? (
            <SettingsListItem
              title={cancelSubscriptionMutation.isPending ? t('billing.canceling') : t('billing.cancelSubscription')}
              onPress={handleCancelSubscription}
              disabled={cancelSubscriptionMutation.isPending}
              destructive
              showChevron={false}
              leftInset={ITEM_TEXT_INSET}
            />
          ) : null}
        </SettingsListGroup>
      ) : null}

      {packages.length > 0 ? (
        <SettingsListGroup title={t('credits.buyCredits')}>
          {packages.map((pkg) => (
            <SettingsListItem
              key={pkg.id}
              icon={<ShoppingCart size={18} color={colors.textSecondary} />}
              title={pkg.name}
              description={t('credits.perThousand', { price: `$${((pkg.price / pkg.credits) * 1000 / 100).toFixed(2)}` })}
              value={`$${(pkg.price / 100).toFixed(2)}`}
              onPress={() => handlePurchaseCredits(pkg.id)}
              disabled={createCheckoutMutation.isPending}
            />
          ))}
          <SettingsListItem
            title={t('billing.customAmount')}
            leftInset={ITEM_TEXT_INSET}
            rightElement={
              <View className="flex-row items-center gap-2">
                <TextInput
                  value={customCredits}
                  onChangeText={(text) => setCustomCredits(text.replace(/[^0-9]/g, ''))}
                  placeholder={t('billing.customAmountPlaceholder')}
                  keyboardType="number-pad"
                  className="w-28 py-1.5 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
                  placeholderTextColor={colors.textSecondary}
                />
                <Button
                  variant="outline"
                  onPress={handleCustomPurchase}
                  disabled={!canBuyCustom || createCustomCheckoutMutation.isPending}
                  size="sm"
                  className="rounded-full h-8 px-3"
                  isLoading={createCustomCheckoutMutation.isPending}
                >
                  <Text className="text-foreground font-medium text-xs">
                    {customPriceCents > 0 ? `$${(customPriceCents / 100).toFixed(2)}` : t('billing.buy')}
                  </Text>
                </Button>
              </View>
            }
          />
        </SettingsListGroup>
      ) : null}

      <SettingsListGroup title={t('billing.paymentMethods')}>
        <SettingsListItem
          icon={<CreditCard size={18} color={colors.textSecondary} />}
          title={createPortalMutation.isPending ? t('common.loading') : t('billing.managePaymentMethods')}
          onPress={handleManagePayment}
          disabled={createPortalMutation.isPending}
          showChevron={false}
          rightElement={<ExternalLink size={14} color={colors.textTertiary} />}
        />
      </SettingsListGroup>

      {transactionsData && transactionsData.transactions.length > 0 ? (
        <SettingsListGroup title={t('billing.recentTransactions')}>
          {transactionsData.transactions.map((transaction) => (
            <SettingsListItem
              key={transaction._id}
              title={transaction.description || transaction.type}
              description={`${new Date(transaction.createdAt).toLocaleDateString()} · $${(transaction.amount / 100).toFixed(2)}`}
              value={`+${transaction.credits.toLocaleString()}`}
              leftInset={ITEM_TEXT_INSET}
            />
          ))}
        </SettingsListGroup>
      ) : null}
    </View>
  );
}
