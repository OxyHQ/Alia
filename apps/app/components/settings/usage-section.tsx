import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useRouter } from "expo-router";
import { useCredits } from "@/lib/hooks/use-credits";
import { useSubscription } from "@/lib/hooks/use-billing";
import { useTranslation } from "@/hooks/useTranslation";
import { Sparkle, ExternalLink } from "lucide-react-native";

export function UsageSection() {
  const router = useRouter();
  const { data: creditsInfo, isLoading } = useCredits();
  const { data: subscription } = useSubscription();
  const { t } = useTranslation();

  const isSubscribed = subscription && subscription.status === "active";

  if (isLoading) {
    return (
      <View className="py-4">
        <Text className="text-sm text-muted-foreground">{t("common.loading")}</Text>
      </View>
    );
  }

  return (
    <View className="gap-6">
      {/* Plan Badge */}
      <View className="border border-border rounded-xl p-4">
        <View className="flex-row items-center justify-between mb-4">
          <Text className="text-lg font-bold">
            {isSubscribed ? subscription.plan.name : t("credits.free")}
          </Text>
          {!isSubscribed && (
            <Button
              onPress={() => router.push("/(biglayout)/subscribe")}
              size="sm"
              className="rounded-full"
            >
              <Sparkle size={14} className="text-primary-foreground mr-1" />
              <Text className="text-primary-foreground text-sm font-medium">
                {t("credits.upgrade")}
              </Text>
            </Button>
          )}
        </View>

        {/* Credits */}
        {creditsInfo && (
          <View className="gap-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">{t("credits.credits")}</Text>
              <Text className="text-base font-semibold">
                {creditsInfo.credits.toLocaleString()}
              </Text>
            </View>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">
                {t("credits.freeCredits")}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {creditsInfo.freeCredits.toLocaleString()}
              </Text>
            </View>
            {creditsInfo.dailyRefresh > 0 && (
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">
                  {t("credits.dailyRefresh")}
                </Text>
                <Text className="text-base font-semibold">
                  {creditsInfo.dailyRefresh.toLocaleString()}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Billing Link */}
      <Button
        variant="outline"
        onPress={() => router.push("/(app)/billing")}
        className="flex-row items-center justify-center gap-2"
      >
        <Text className="text-sm font-medium">{t("credits.manageBilling")}</Text>
        <ExternalLink size={14} className="text-muted-foreground" />
      </Button>
    </View>
  );
}
