import { View, ScrollView, Pressable, Linking, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, RefreshCw, CreditCard, ExternalLink, X } from "lucide-react-native";
import { useCredits } from "@/lib/hooks/use-credits";
import { useCreditPackages, useSubscriptionPlans, useSubscription, useCreateCheckout, useCreateSubscriptionCheckout, useCancelSubscription, useCreatePortalSession, useTransactions } from "@/lib/hooks/use-billing";
import { useEffect, useState } from "react";
import { useAuth } from "@oxyhq/services";
import { toast } from "@/components/sonner";

function getOriginUrl(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return getOriginUrl();
  }
  return 'https://alia.onl';
}

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

  // Set mounted state
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Redirect if not authenticated
  useEffect(() => {
    if (isMounted && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isMounted, isAuthenticated]);

  // Handle successful payment
  useEffect(() => {
    if (isMounted && success === 'true') {
      // Refetch all billing data
      refetch();
      refetchSubscription();
      refetchTransactions();

      // Show success message
      toast.success("Payment successful! Your credits have been added.");

      // Remove success param from URL
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
      return "Less than 1 hour";
    } else if (hoursUntil < 2) {
      return "About 1 hour";
    } else {
      return `About ${Math.floor(hoursUntil)} hours`;
    }
  };

  const handlePurchaseCredits = async (packageId: string) => {
    try {
      const { url } = await createCheckoutMutation.mutateAsync({
        packageId,
        successUrl: getOriginUrl() + "/billing?success=true",
        cancelUrl: getOriginUrl() + "/billing",
      });

      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to create checkout");
    }
  };

  const handleSubscribe = async (planId: string) => {
    try {
      const { url } = await createSubscriptionCheckoutMutation.mutateAsync({
        planId,
        successUrl: getOriginUrl() + "/billing?success=true",
        cancelUrl: getOriginUrl() + "/billing",
      });

      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to create checkout");
    }
  };

  const handleCancelSubscription = async () => {
    try {
      await cancelSubscriptionMutation.mutateAsync();
      toast.success("Subscription will be canceled at the end of the billing period");
    } catch (error: any) {
      toast.error(error.message || "Failed to cancel subscription");
    }
  };

  const handleManagePayment = async () => {
    try {
      const url = await createPortalMutation.mutateAsync(getOriginUrl() + "/billing");
      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to open customer portal");
    }
  };

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">Billing</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Manage your credits and usage
        </Text>
      </View>

      {isLoading ? (
        <View className="px-6 py-6">
          <Text className="text-sm text-muted-foreground">Loading...</Text>
        </View>
      ) : creditsInfo ? (
        <>
          {/* Current Balance */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">Current balance</Text>
            <View className="flex-row items-baseline gap-2 mb-2">
              <Text className="text-4xl font-semibold text-foreground">
                {creditsInfo.credits.toLocaleString()}
              </Text>
              <Text className="text-sm text-muted-foreground">credits</Text>
            </View>
            {creditsInfo.paidCredits > 0 && (
              <Text className="text-sm text-muted-foreground">
                {creditsInfo.paidCredits.toLocaleString()} paid credits
              </Text>
            )}
          </View>

          {/* Active Subscription */}
          {subscription && subscription.status === 'active' && (
            <View className="px-6 py-6 border-b border-border">
              <Text className="text-sm font-semibold text-foreground mb-4">Active subscription</Text>
              <View className="p-4 rounded-md bg-blue-50 border border-blue-200 mb-4">
                <View className="flex-row items-center justify-between mb-2">
                  <Text className="text-base font-semibold text-blue-900">{subscription.plan.name}</Text>
                  <Text className="text-sm font-semibold text-blue-900">
                    ${(subscription.plan.price / 100).toFixed(2)}/mo
                  </Text>
                </View>
                <Text className="text-sm text-blue-800 mb-2">
                  {subscription.plan.creditsPerMonth.toLocaleString()} credits per month
                </Text>
                <Text className="text-xs text-blue-700">
                  {subscription.cancelAtPeriodEnd
                    ? `Cancels on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                    : `Renews on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
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
                    {cancelSubscriptionMutation.isPending ? "Canceling..." : "Cancel subscription"}
                  </Text>
                </Button>
              )}
            </View>
          )}

          {/* Purchase Credits */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">Purchase credits</Text>
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
                    ${((pkg.price / pkg.credits) * 1000 / 100).toFixed(2)} per 1,000 credits
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Subscription Plans */}
          {!subscription && plans.length > 0 && (
            <View className="px-6 py-6 border-b border-border">
              <Text className="text-sm font-semibold text-foreground mb-4">Subscription plans</Text>
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
                        ${(plan.price / 100).toFixed(2)}/mo
                      </Text>
                    </View>
                    <Text className="text-sm text-muted-foreground mb-1">
                      {plan.creditsPerMonth.toLocaleString()} credits per month
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      ${((plan.price / plan.creditsPerMonth) * 1000 / 100).toFixed(2)} per 1,000 credits
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {/* Payment Methods */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">Payment methods</Text>
            <Button
              variant="outline"
              onPress={handleManagePayment}
              disabled={createPortalMutation.isPending}
              size="sm"
              className="self-start"
            >
              <CreditCard size={14} className="text-foreground mr-1.5" />
              <Text className="text-foreground font-medium text-sm">
                {createPortalMutation.isPending ? "Loading..." : "Manage payment methods"}
              </Text>
              <ExternalLink size={12} className="text-muted-foreground ml-1.5" />
            </Button>
          </View>

          {/* Recent Transactions */}
          {transactionsData && transactionsData.transactions.length > 0 && (
            <View className="px-6 py-6 border-b border-border">
              <Text className="text-sm font-semibold text-foreground mb-4">Recent transactions</Text>
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
                        +{transaction.credits.toLocaleString()} credits
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
            <Text className="text-sm font-semibold text-foreground mb-4">Free credits</Text>

            <View className="mb-4">
              <Text className="text-sm text-muted-foreground mb-1">Daily allowance</Text>
              <Text className="text-sm text-foreground">
                {creditsInfo.freeCredits.toLocaleString()} credits
              </Text>
            </View>

            <View className="mb-4">
              <Text className="text-sm text-muted-foreground mb-1">Daily refresh</Text>
              <Text className="text-sm text-foreground">
                +{creditsInfo.dailyRefresh.toLocaleString()} credits every 24 hours
              </Text>
            </View>

            <View>
              <Text className="text-sm text-muted-foreground mb-1">Next refresh</Text>
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
              <Text className="text-sm font-medium text-foreground">Refresh balance</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <View className="px-6 py-6">
          <Text className="text-sm text-muted-foreground">Failed to load billing information</Text>
        </View>
      )}
    </ScrollView>
  );
}
