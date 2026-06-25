import { View, Pressable, TextInput } from "react-native";
import * as Linking from "expo-linking";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useRouter } from "expo-router";
import { CreditCard, ExternalLink, Sparkle, Crown, Calendar, ShoppingCart } from "lucide-react-native";
import { useCredits } from "@/lib/hooks/use-credits";
import { useSubscription, useSubscriptionPolling, useCancelSubscription, useCreatePortalSession, useTransactions, useCreditPackages, useCreateCheckout, useCreateCustomCheckout, useCreditPrice } from "@/lib/hooks/use-billing";
import { useEffect, useState, useRef } from "react";
import { toast } from "@/components/sonner";
import { useTranslation } from "@/hooks/useTranslation";
import { errorMessage as getErrorMessage } from '../../lib/errors/error-utils';

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
    <View className="gap-3">
      {/* Credits breakdown */}
      <View className="border border-border rounded-xl p-3 gap-3">
        <View className="flex-row items-center gap-2">
          <Sparkle size={16} className="text-foreground" />
          <Text className="text-sm font-semibold text-foreground">{t('credits.credits')}</Text>
          {!isSubscribed && (
            <Button
              onPress={() => router.push("/(biglayout)/subscribe")}
              size="sm"
              className="rounded-full ml-auto h-7 px-3"
            >
              <Text className="text-primary-foreground font-medium text-xs">
                {t('credits.upgrade')}
              </Text>
            </Button>
          )}
        </View>
        <View className="flex-row items-baseline justify-between">
          <Text className="text-sm text-muted-foreground">{t('credits.freeCredits')}</Text>
          <View className="flex-row items-baseline gap-1">
            <Text className="text-xl font-bold text-foreground">{freeCredits.toLocaleString()}</Text>
            <Text className="text-xs text-muted-foreground">/ {creditsInfo.freeLimit.toLocaleString()}</Text>
          </View>
        </View>
        {creditsInfo.paidCredits > 0 && (
          <View className="flex-row items-baseline justify-between">
            <Text className="text-sm text-muted-foreground">{t('credits.paidCredits')}</Text>
            <Text className="text-base font-semibold text-foreground">{creditsInfo.paidCredits.toLocaleString()}</Text>
          </View>
        )}
        {creditsInfo.dailyRefresh > 0 && (
          <View className="flex-row items-center justify-between pt-1 border-t border-border">
            <View className="flex-row items-center gap-1.5">
              <Calendar size={13} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">{t('credits.dailyRefresh')}</Text>
            </View>
            <Text className="text-sm font-semibold text-foreground">+{creditsInfo.dailyRefresh}</Text>
          </View>
        )}
      </View>

      {/* Active Subscription */}
      {isSubscribed && (
        <View className="border border-border rounded-xl p-3 gap-3">
          <View className="flex-row items-center gap-2">
            <Crown size={16} className="text-foreground" />
            <Text className="text-sm font-semibold text-foreground">{t('billing.activeSubscription')}</Text>
          </View>
          <View className="flex-row items-baseline justify-between">
            <Text className="text-sm text-muted-foreground">{subscription.plan.name}</Text>
            <Text className="text-base font-semibold text-primary">
              ${(subscription.plan.price / 100).toFixed(2)}{t('credits.perMonth')}
            </Text>
          </View>
          <View className="flex-row items-baseline justify-between">
            <Text className="text-xs text-muted-foreground">
              {t('billing.creditsPerMonth', { count: subscription.plan.creditsPerMonth.toLocaleString() })}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {subscription.cancelAtPeriodEnd
                ? t('billing.cancelsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })
                : t('billing.renewsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })}
            </Text>
          </View>
          <View className="flex-row gap-2 pt-1 border-t border-border">
            <Button
              variant="outline"
              onPress={() => router.push("/(biglayout)/subscribe")}
              size="sm"
              className="rounded-full h-7 px-3"
            >
              <Text className="text-foreground font-medium text-xs">
                {t('billing.changePlan')}
              </Text>
            </Button>
            {!subscription.cancelAtPeriodEnd && (
              <Button
                variant="outline"
                onPress={handleCancelSubscription}
                disabled={cancelSubscriptionMutation.isPending}
                size="sm"
                className="rounded-full h-7 px-3"
              >
                <Text className="text-foreground font-medium text-xs">
                  {cancelSubscriptionMutation.isPending ? t('billing.canceling') : t('billing.cancelSubscription')}
                </Text>
              </Button>
            )}
          </View>
        </View>
      )}

      {/* Buy Credits */}
      {packages.length > 0 && (
        <View className="border border-border rounded-xl p-3 gap-2">
          <View className="flex-row items-center gap-2 mb-1">
            <ShoppingCart size={14} className="text-muted-foreground" />
            <Text className="text-xs font-medium text-muted-foreground">{t('credits.buyCredits')}</Text>
          </View>
          {packages.map((pkg) => (
            <Pressable
              key={pkg.id}
              onPress={() => handlePurchaseCredits(pkg.id)}
              disabled={createCheckoutMutation.isPending}
              className="flex-row items-center justify-between py-2 px-3 rounded-lg border border-border bg-background active:bg-muted"
            >
              <View>
                <Text className="text-sm font-medium text-foreground">{pkg.name}</Text>
                <Text className="text-[10px] text-muted-foreground">
                  {t('credits.perThousand', { price: `$${((pkg.price / pkg.credits) * 1000 / 100).toFixed(2)}` })}
                </Text>
              </View>
              <Text className="text-sm font-semibold text-foreground">
                ${(pkg.price / 100).toFixed(2)}
              </Text>
            </Pressable>
          ))}

          {/* Custom amount */}
          <View className="flex-row items-center gap-2 pt-2 border-t border-border">
            <TextInput
              value={customCredits}
              onChangeText={(text) => setCustomCredits(text.replace(/[^0-9]/g, ''))}
              placeholder={t('billing.customAmountPlaceholder')}
              keyboardType="number-pad"
              className="flex-1 py-1.5 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
              placeholderTextColor="#999"
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
        </View>
      )}

      {/* Payment Methods */}
      <View className="border border-border rounded-xl p-3">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-foreground">{t('billing.paymentMethods')}</Text>
          <Button
            variant="outline"
            onPress={handleManagePayment}
            disabled={createPortalMutation.isPending}
            size="sm"
            className="rounded-full h-7 px-3"
          >
            <CreditCard size={12} className="text-foreground mr-1" />
            <Text className="text-foreground font-medium text-xs">
              {createPortalMutation.isPending ? t('common.loading') : t('billing.managePaymentMethods')}
            </Text>
            <ExternalLink size={10} className="text-muted-foreground ml-1" />
          </Button>
        </View>
      </View>

      {/* Recent Transactions */}
      {transactionsData && transactionsData.transactions.length > 0 && (
        <View className="border border-border rounded-xl p-3 gap-2">
          <Text className="text-sm font-semibold text-foreground">{t('billing.recentTransactions')}</Text>
          {transactionsData.transactions.map((transaction, index) => (
            <View
              key={transaction._id}
              className={`py-2 ${index < transactionsData.transactions.length - 1 ? 'border-b border-border' : ''}`}
            >
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-foreground">
                  {transaction.description || transaction.type}
                </Text>
                <Text className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                  +{transaction.credits.toLocaleString()}
                </Text>
              </View>
              <View className="flex-row items-center justify-between mt-0.5">
                <Text className="text-[11px] text-muted-foreground">
                  {new Date(transaction.createdAt).toLocaleDateString()}
                </Text>
                <Text className="text-[11px] text-muted-foreground">
                  ${(transaction.amount / 100).toFixed(2)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
