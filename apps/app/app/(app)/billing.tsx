import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useRouter } from "expo-router";
import { ArrowLeft, RefreshCw } from "lucide-react-native";
import { useCredits } from "@/lib/hooks/use-credits";
import { useEffect } from "react";
import { useAuthStore } from "@/lib/stores/auth-store";

export default function BillingScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();
  const { data: creditsInfo, isLoading, refetch } = useCredits();

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated]);

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
            <Text className="text-sm text-muted-foreground">
              of {creditsInfo.freeCredits.toLocaleString()} available
            </Text>
          </View>

          {/* Free Credits */}
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

            <View className="mb-4">
              <Text className="text-sm text-muted-foreground mb-1">Last refresh</Text>
              <Text className="text-sm text-foreground">
                {new Date(creditsInfo.lastRefresh).toLocaleString()}
              </Text>
            </View>

            <View>
              <Text className="text-sm text-muted-foreground mb-1">Next refresh</Text>
              <Text className="text-sm text-foreground">{getTimeUntilRefresh()}</Text>
            </View>
          </View>

          {/* How Credits Work */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">How credits work</Text>

            <View className="mb-3">
              <Text className="text-sm text-foreground mb-1">• Chat messages</Text>
              <Text className="text-sm text-muted-foreground ml-4">
                Each message consumes credits based on the model and length
              </Text>
            </View>

            <View className="mb-3">
              <Text className="text-sm text-foreground mb-1">• Daily refresh</Text>
              <Text className="text-sm text-muted-foreground ml-4">
                Your credits refresh automatically every 24 hours
              </Text>
            </View>

            <View>
              <Text className="text-sm text-foreground mb-1">• API usage</Text>
              <Text className="text-sm text-muted-foreground ml-4">
                API calls through developer apps use your credit balance
              </Text>
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
