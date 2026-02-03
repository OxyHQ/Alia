import { View, ScrollView, Pressable, Linking } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, RefreshCw, CreditCard, ExternalLink, X } from "lucide-react-native";
import { useCredits } from "@/lib/hooks/use-credits";
import { useCreditPackages, useSubscriptionPlans, useSubscription, useCreateCheckout, useCreateSubscriptionCheckout, useCancelSubscription, useCreatePortalSession, useTransactions } from "@/lib/hooks/use-billing";
import { useEffect, useState } from "react";
import { useAuth } from "@oxyhq/services";
import { toast } from "@/components/sonner";
import { useTranslation } from "@/hooks/useTranslation";

export default function BillingScreen() {
  const router = useRouter();
  const { success } = useLocalSearchParams();
  const { isAuthenticated } = useAuth();
  const { data: creditsInfo, isLoading, refetch } = useCredits();
  const { data: packages = [] } = useCreditPackages();
  const { data: plans = [] } = useSubscriptionPlans();
  const { data: subscription, refetch: refetchSubscription } = useSubscription();
  const { data: transactionsData, refetch: refetchTransactions } = useTransactions(10, 0);
  const createCheckoutMutation = useCreateCheckout();
  const createSubscriptionCheckoutMutation = useCreateSubscriptionCheckout();
  const cancelSubscriptionMutation = useCancelSubscription();
  const createPortalMutation = useCreatePortalSession();
  const [isMounted, setIsMounted] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (isMounted && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isMounted, isAuthenticated]);

  useEffect(() => {
    if (isMounted && success === 'true') {
      refetch();
      refetchSubscription();
      refetchTransactions();
      toast.success(t('billing.paymentSuccess'));
      setTimeout(() => {
        router.replace("/billing");
      }, 100);
    }
  }, [isMounted, success]);

  const getTimeUntilRefresh = () => {
    if (!creditsInfo?.lastRefresh) return "N/A";

    const lastRefresh = new Date(creditsInfo.lastRefresh);
    const now = new Date();
    const hoursSince = (now.getTime() - lastRefresh.getTime()) / (1000 * 60 * 60);
    const hoursUntil = Math.max(0, 24 - hoursSince);

    if (hoursUntil < 1) {
      return t('billing.lessThanOneHour');
    } else if (hoursUntil < 2) {
      return t('billing.aboutOneHour');
    } else {
      return t('billing.aboutHours', { count: Math.floor(hoursUntil) });
    }
  };

  const handlePurchaseCredits = async (packageId: string) => {
    try {
      const { url } = await createCheckoutMutation.mutateAsync({
        packageId,
        successUrl: Linking.createURL("/billing?success=true"),
        cancelUrl: Linking.createURL("/billing"),
      });

      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: any) {
      toast.error(error.message || t('billing.failedCheckout'));
    }
  };

  const handleSubscribe = async (planId: string) => {
    try {
      const { url } = await createSubscriptionCheckoutMutation.mutateAsync({
        planId,
        successUrl: Linking.createURL("/billing?success=true"),
        cancelUrl: Linking.createURL("/billing"),
      });

      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: any) {
      toast.error(error.message || t('billing.failedCheckout'));
    }
  };

  const handleCancelSubscription = async () => {
    try {
      await cancelSubscriptionMutation.mutateAsync();
      toast.success(t('billing.cancelSubscriptionSuccess'));
    } catch (error: any) {
      toast.error(error.message || t('billing.failedCancelSubscription'));
    }
  };

  const handleManagePayment = async () => {
    try {
      const url = await createPortalMutation.mutateAsync(Linking.createURL("/billing"));
      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: any) {
      toast.error(error.message || t('billing.failedPortal'));
    }
  };

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">{t('common.back')}</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">{t('billing.title')}</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          {t('billing.subtitle')}
        </Text>
      </View>

      {isLoading ? (
        <View className="px-6 py-6">
          <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
        </View>
      ) : creditsInfo ? (
        <>
          {/* Current Balance */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">{t('billing.currentBalance')}</Text>
            <View className="flex-row items-baseline gap-2 mb-2">
              <Text className="text-4xl font-semibold text-foreground">
                {creditsInfo.credits.toLocaleString()}
              </Text>
              <Text className="text-sm text-muted-foreground">{t('billing.credits')}</Text>
            </View>
            {creditsInfo.paidCredits > 0 && (
              <Text className="text-sm text-muted-foreground">
                {t('billing.paidCreditsCount', { count: creditsInfo.paidCredits.toLocaleString() })}
              </Text>
            )}
          </View>

          {/* Active Subscription */}
          {subscription && subscription.status === 'active' && (
            <View className="px-6 py-6 border-b border-border">
              <Text className="text-sm font-semibold text-foreground mb-4">{t('billing.activeSubscription')}</Text>
              <View className="p-4 rounded-md bg-blue-50 border border-blue-200 mb-4">
                <View className="flex-row items-center justify-between mb-2">
                  <Text className="text-base font-semibold text-blue-900">{subscription.plan.name}</Text>
                  <Text className="text-sm font-semibold text-blue-900">
                    ${(subscription.plan.price / 100).toFixed(2)}{t('credits.perMonth')}
                  </Text>
                </View>
                <Text className="text-sm text-blue-800 mb-2">
                  {t('billing.creditsPerMonth', { count: subscription.plan.creditsPerMonth.toLocaleString() })}
                </Text>
                <Text className="text-xs text-blue-700">
                  {subscription.cancelAtPeriodEnd
                    ? t('billing.cancelsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })
                    : t('billing.renewsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })}
                </Text>
              </View>
              {!subscription.cancelAtPeriodEnd && (
                <Button
                  variant="outline"
                  onPress={handleCancelSubscription}
                  disabled={cancelSubscriptionMutation.isPending}
                  size="sm"
                  className="self-start"
                >
                  <X size={14} className="text-foreground mr-1.5" />
                  <Text className="text-foreground font-medium text-sm">
                    {cancelSubscriptionMutation.isPending ? t('billing.canceling') : t('billing.cancelSubscription')}
                  </Text>
                </Button>
              )}
            </View>
          )}

          {/* Purchase Credits */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">{t('billing.purchaseCredits')}</Text>
            <View className="gap-3">
              {packages.map((pkg) => (
                <Pressable
                  key={pkg.id}
                  onPress={() => handlePurchaseCredits(pkg.id)}
                  disabled={createCheckoutMutation.isPending}
                  className="p-4 rounded-md border border-border bg-background active:bg-muted"
                >
                  <View className="flex-row items-center justify-between mb-1">
                    <Text className="text-base font-semibold text-foreground">{pkg.name}</Text>
                    <Text className="text-base font-semibold text-foreground">
                      ${(pkg.price / 100).toFixed(2)}
                    </Text>
                  </View>
                  <Text className="text-sm text-muted-foreground">
                    {t('billing.perThousandCredits', { price: `$${((pkg.price / pkg.credits) * 1000 / 100).toFixed(2)}` })}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Subscription Plans */}
          {!subscription && plans.length > 0 && (
            <View className="px-6 py-6 border-b border-border">
              <Text className="text-sm font-semibold text-foreground mb-4">{t('billing.subscriptionPlans')}</Text>
              <View className="gap-3">
                {plans.map((plan) => (
                  <Pressable
                    key={plan.id}
                    onPress={() => handleSubscribe(plan.id)}
                    disabled={createSubscriptionCheckoutMutation.isPending}
                    className="p-4 rounded-md border border-border bg-background active:bg-muted"
                  >
                    <View className="flex-row items-center justify-between mb-2">
                      <Text className="text-base font-semibold text-foreground">{plan.name}</Text>
                      <Text className="text-base font-semibold text-foreground">
                        ${(plan.price / 100).toFixed(2)}{t('credits.perMonth')}
                      </Text>
                    </View>
                    <Text className="text-sm text-muted-foreground mb-1">
                      {t('billing.creditsPerMonth', { count: plan.creditsPerMonth.toLocaleString() })}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      {t('billing.perThousandCredits', { price: `$${((plan.price / plan.creditsPerMonth) * 1000 / 100).toFixed(2)}` })}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {/* Payment Methods */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">{t('billing.paymentMethods')}</Text>
            <Button
              variant="outline"
              onPress={handleManagePayment}
              disabled={createPortalMutation.isPending}
              size="sm"
              className="self-start"
            >
              <CreditCard size={14} className="text-foreground mr-1.5" />
              <Text className="text-foreground font-medium text-sm">
                {createPortalMutation.isPending ? t('common.loading') : t('billing.managePaymentMethods')}
              </Text>
              <ExternalLink size={12} className="text-muted-foreground ml-1.5" />
            </Button>
          </View>

          {/* Recent Transactions */}
          {transactionsData && transactionsData.transactions.length > 0 && (
            <View className="px-6 py-6 border-b border-border">
              <Text className="text-sm font-semibold text-foreground mb-4">{t('billing.recentTransactions')}</Text>
              <View>
                {transactionsData.transactions.map((transaction, index) => (
                  <View
                    key={transaction._id}
                    className={`py-3 ${index < transactionsData.transactions.length - 1 ? 'border-b border-border' : ''}`}
                  >
                    <View className="flex-row items-center justify-between mb-1">
                      <Text className="text-sm font-medium text-foreground">
                        {transaction.description || transaction.type}
                      </Text>
                      <Text className="text-sm text-foreground">
                        +{transaction.credits.toLocaleString()} {t('billing.credits')}
                      </Text>
                    </View>
                    <View className="flex-row items-center justify-between">
                      <Text className="text-xs text-muted-foreground">
                        {new Date(transaction.createdAt).toLocaleDateString()}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        ${(transaction.amount / 100).toFixed(2)}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Free Credits Info */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">{t('billing.freeCredits')}</Text>

            <View className="mb-4">
              <Text className="text-sm text-muted-foreground mb-1">{t('billing.dailyAllowance')}</Text>
              <Text className="text-sm text-foreground">
                {t('billing.creditsCount', { count: creditsInfo.freeCredits.toLocaleString() })}
              </Text>
            </View>

            <View className="mb-4">
              <Text className="text-sm text-muted-foreground mb-1">{t('billing.dailyRefresh')}</Text>
              <Text className="text-sm text-foreground">
                {t('billing.creditsEvery24h', { count: creditsInfo.dailyRefresh.toLocaleString() })}
              </Text>
            </View>

            <View>
              <Text className="text-sm text-muted-foreground mb-1">{t('billing.nextRefresh')}</Text>
              <Text className="text-sm text-foreground">{getTimeUntilRefresh()}</Text>
            </View>
          </View>

          {/* Refresh Button */}
          <View className="px-6 py-6">
            <Pressable
              onPress={() => refetch()}
              className="flex-row items-center justify-center py-3 px-4 rounded-md border border-border bg-background active:opacity-70"
            >
              <RefreshCw size={16} className="text-foreground mr-2" />
              <Text className="text-sm font-medium text-foreground">{t('billing.refreshBalance')}</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <View className="px-6 py-6">
          <Text className="text-sm text-muted-foreground">{t('billing.failedToLoad')}</Text>
        </View>
      )}
    </ScrollView>
  );
}
