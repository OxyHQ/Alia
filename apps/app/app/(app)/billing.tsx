import { View, ScrollView, Pressable } from "react-native";
import * as Linking from "expo-linking";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, CreditCard, ExternalLink, X, Sparkle } from "lucide-react-native";
import { useCredits } from "@/lib/hooks/use-credits";
import { useSubscription, useSubscriptionPolling, useCancelSubscription, useCreatePortalSession, useTransactions } from "@/lib/hooks/use-billing";
import { useEffect, useState, useRef } from "react";
import { useAuth } from "@oxyhq/services";
import { toast } from "@/components/sonner";
import { useTranslation } from "@/hooks/useTranslation";

export default function BillingScreen() {
  const router = useRouter();
  const { success } = useLocalSearchParams();
  const { isAuthenticated } = useAuth();
  const { data: creditsInfo, isLoading, refetch } = useCredits();
  const { data: subscription, refetch: refetchSubscription } = useSubscription();
  const { data: transactionsData, refetch: refetchTransactions } = useTransactions(10, 0);
  const cancelSubscriptionMutation = useCancelSubscription();
  const createPortalMutation = useCreatePortalSession();
  const [isMounted, setIsMounted] = useState(false);
  const { t } = useTranslation();

  const isPaymentSuccess = isMounted && success === 'true';
  const toastShown = useRef(false);

  const { data: polledSubscription } = useSubscriptionPolling(undefined, {
    enabled: isPaymentSuccess,
  });

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (isMounted && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isMounted, isAuthenticated]);

  // Show success toast once subscription is confirmed via polling
  useEffect(() => {
    if (!isPaymentSuccess || toastShown.current) return;

    if (polledSubscription && (polledSubscription.status === 'active' || polledSubscription.status === 'trialing')) {
      toastShown.current = true;
      refetch();
      refetchSubscription();
      refetchTransactions();
      toast.success(t('billing.paymentSuccess'));
      setTimeout(() => router.replace("/billing"), 100);
    }
  }, [isPaymentSuccess, polledSubscription]);

  // Timeout fallback
  useEffect(() => {
    if (!isPaymentSuccess || toastShown.current) return;

    const timeout = setTimeout(() => {
      if (!toastShown.current) {
        toastShown.current = true;
        refetch();
        refetchSubscription();
        refetchTransactions();
        toast.success(t('billing.paymentSuccess'));
        setTimeout(() => router.replace("/billing"), 100);
      }
    }, 32000);
    return () => clearTimeout(timeout);
  }, [isPaymentSuccess]);

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

  const isSubscribed = subscription && subscription.status === 'active';

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 pt-6 pb-4">
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
        <View className="px-4 py-6">
          <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
        </View>
      ) : creditsInfo ? (
        <View className="px-4 gap-3 pb-6">
          {/* Credit Balance Card */}
          <View className="rounded-xl bg-muted/50 p-5 flex-row items-center justify-between">
            <View className="flex-row items-center gap-3">
              <View className="w-10 h-10 rounded-full bg-primary/10 items-center justify-center">
                <Sparkle size={18} className="text-primary" />
              </View>
              <View>
                <Text className="text-2xl font-bold text-foreground">
                  {creditsInfo.credits.toLocaleString()}
                </Text>
                <Text className="text-xs text-muted-foreground">{t('billing.currentBalance')}</Text>
              </View>
            </View>
            {!isSubscribed && (
              <Button
                onPress={() => router.push("/(biglayout)/subscribe")}
                size="sm"
                className="rounded-full"
              >
                <Text className="text-primary-foreground font-medium text-sm">
                  {t('credits.upgrade')}
                </Text>
              </Button>
            )}
          </View>

          {/* Active Subscription Card */}
          {isSubscribed && (
            <View className="rounded-xl bg-muted/50 p-5 gap-4">
              <Text className="text-sm font-semibold text-foreground">{t('billing.activeSubscription')}</Text>
              <View className="p-4 rounded-lg bg-primary/10 border border-primary/20 gap-2">
                <View className="flex-row items-center justify-between">
                  <Text className="text-base font-semibold text-foreground">{subscription.plan.name}</Text>
                  <Text className="text-sm font-semibold text-primary">
                    ${(subscription.plan.price / 100).toFixed(2)}{t('credits.perMonth')}
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">
                  {t('billing.creditsPerMonth', { count: subscription.plan.creditsPerMonth.toLocaleString() })}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {subscription.cancelAtPeriodEnd
                    ? t('billing.cancelsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })
                    : t('billing.renewsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })}
                </Text>
              </View>
              <View className="flex-row gap-2">
                <Button
                  variant="outline"
                  onPress={() => router.push("/(biglayout)/subscribe")}
                  size="sm"
                  className="rounded-full"
                >
                  <Text className="text-foreground font-medium text-sm">
                    {t('billing.changePlan')}
                  </Text>
                </Button>
                {!subscription.cancelAtPeriodEnd && (
                  <Button
                    variant="outline"
                    onPress={handleCancelSubscription}
                    disabled={cancelSubscriptionMutation.isPending}
                    size="sm"
                    className="rounded-full"
                  >
                    <X size={14} className="text-foreground mr-1.5" />
                    <Text className="text-foreground font-medium text-sm">
                      {cancelSubscriptionMutation.isPending ? t('billing.canceling') : t('billing.cancelSubscription')}
                    </Text>
                  </Button>
                )}
              </View>
            </View>
          )}

          {/* Payment Methods Card */}
          <View className="rounded-xl bg-muted/50 p-5 gap-4">
            <Text className="text-sm font-semibold text-foreground">{t('billing.paymentMethods')}</Text>
            <Button
              variant="outline"
              onPress={handleManagePayment}
              disabled={createPortalMutation.isPending}
              size="sm"
              className="self-start rounded-full"
            >
              <CreditCard size={14} className="text-foreground mr-1.5" />
              <Text className="text-foreground font-medium text-sm">
                {createPortalMutation.isPending ? t('common.loading') : t('billing.managePaymentMethods')}
              </Text>
              <ExternalLink size={12} className="text-muted-foreground ml-1.5" />
            </Button>
          </View>

          {/* Recent Transactions Card */}
          {transactionsData && transactionsData.transactions.length > 0 && (
            <View className="rounded-xl bg-muted/50 p-5 gap-3">
              <Text className="text-sm font-semibold text-foreground">{t('billing.recentTransactions')}</Text>
              <View className="rounded-lg overflow-hidden">
                {transactionsData.transactions.map((transaction, index) => (
                  <View
                    key={transaction._id}
                    className={`py-3 px-1 ${index < transactionsData.transactions.length - 1 ? 'border-b border-border' : ''}`}
                  >
                    <View className="flex-row items-center justify-between mb-1">
                      <Text className="text-sm font-medium text-foreground">
                        {transaction.description || transaction.type}
                      </Text>
                      <Text className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
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
        </View>
      ) : (
        <View className="px-4 py-6">
          <Text className="text-sm text-muted-foreground">{t('billing.failedToLoad')}</Text>
        </View>
      )}
    </ScrollView>
  );
}
