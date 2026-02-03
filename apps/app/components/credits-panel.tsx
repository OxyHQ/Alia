import { useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Sparkles, Calendar, X, Crown } from "lucide-react-native";
import { useCredits, useCreditsUsage } from "@/lib/hooks/use-credits";
import { useSubscription } from "@/lib/hooks/use-billing";
import { useRouter } from "expo-router";
import { useUIStore } from "@/lib/stores/ui-store";
import { useTranslation } from "@/hooks/useTranslation";

type ChartPeriod = "7d" | "30d";

function formatDayLabel(dateStr: string, isLast: boolean, todayLabel: string): string {
  if (isLast) return todayLabel;
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 3);
}

function UsageChart() {
  const [period, setPeriod] = useState<ChartPeriod>("7d");
  const { data: usageData, isLoading } = useCreditsUsage(period);
  const { t } = useTranslation();

  const items = usageData ?? [];
  const maxValue = items.length > 0 ? Math.max(...items.map((d) => d.used)) : 0;
  const totalUsed = items.reduce((acc, d) => acc + d.used, 0);

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        <View>
          <Text className="text-xs text-muted-foreground">{t('credits.totalUsage')}</Text>
          <Text className="text-lg font-bold text-foreground">
            {isLoading ? "–" : totalUsed.toLocaleString()}
          </Text>
        </View>
        <View className="flex-row bg-muted rounded-lg overflow-hidden">
          <Pressable
            onPress={() => setPeriod("7d")}
            className={`px-2.5 py-1 ${period === "7d" ? "bg-background" : ""}`}
          >
            <Text
              className={`text-xs font-medium ${
                period === "7d" ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              7d
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setPeriod("30d")}
            className={`px-2.5 py-1 ${period === "30d" ? "bg-background" : ""}`}
          >
            <Text
              className={`text-xs font-medium ${
                period === "30d" ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              30d
            </Text>
          </Pressable>
        </View>
      </View>

      <View className="flex-row items-end gap-1.5" style={{ height: 100 }}>
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-xs text-muted-foreground">{t('credits.loading')}</Text>
          </View>
        ) : totalUsed === 0 ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-xs text-muted-foreground">{t('credits.noUsage')}</Text>
          </View>
        ) : (
          items.map((item, i) => {
            const barHeight = maxValue > 0 ? (item.used / maxValue) * 100 : 0;
            const isLast = i === items.length - 1;
            const label = period === "7d"
              ? formatDayLabel(item.date, isLast, t('credits.today'))
              : (i % 5 === 0 || isLast ? item.date.slice(5) : "");
            return (
              <View key={item.date} className="flex-1 items-center gap-1.5">
                <View
                  className="w-full items-center justify-end"
                  style={{ height: 80 }}
                >
                  <View
                    className={`w-full rounded-t-sm ${isLast ? "bg-primary" : "bg-primary/30"}`}
                    style={{ height: `${Math.max(barHeight, 4)}%`, minHeight: 3 }}
                  />
                </View>
                <Text
                  className={`text-[10px] ${
                    isLast ? "text-foreground font-medium" : "text-muted-foreground"
                  }`}
                >
                  {label}
                </Text>
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

export function CreditsPanel() {
  const router = useRouter();
  const { data } = useCredits();
  const { data: subscription } = useSubscription();
  const setRightPanel = useUIStore((state) => state.setRightPanel);
  const { t } = useTranslation();

  const credits = data?.credits ?? 0;
  const freeLimit = data?.freeLimit ?? 0;
  const paidCredits = data?.paidCredits ?? 0;
  const dailyRefresh = data?.dailyRefresh ?? 0;
  const isSubscribed = subscription?.status === 'active';

  const navigate = (path: string) => {
    setRightPanel(null);
    router.push(path as any);
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <Text className="text-base font-semibold text-foreground">
          {t('credits.title')}
        </Text>
        <Pressable
          className="p-1 rounded-lg active:opacity-70"
          onPress={() => setRightPanel(null)}
        >
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/* Plan Badge & Upgrade */}
        <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
          <View className="flex-row items-center gap-2">
            <View className={`px-2 py-0.5 rounded-full ${isSubscribed ? 'bg-primary/10' : 'bg-muted'}`}>
              {isSubscribed ? (
                <Text className="text-xs font-medium text-primary">
                  {subscription.plan.name}
                </Text>
              ) : (
                <Text className="text-xs font-medium text-muted-foreground">
                  {t('credits.free')}
                </Text>
              )}
            </View>
          </View>
          <Button onPress={() => navigate("/(app)/billing")} className="h-8 px-4 rounded-full">
            <Text className="text-sm font-medium text-primary-foreground">
              {isSubscribed ? t('credits.manageBilling') : t('credits.upgrade')}
            </Text>
          </Button>
        </View>

        {/* Credits Section */}
        <View className="p-4 gap-5">
          {/* Total Credits */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Sparkles size={18} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                {t('credits.credits')}
              </Text>
            </View>
            <View className="flex-row items-baseline justify-between pl-6">
              <Text className="text-sm text-muted-foreground">
                {t('credits.freeCredits')}
              </Text>
              <View className="flex-row items-baseline gap-1">
                <Text className="text-2xl font-bold text-foreground">
                  {(credits - paidCredits).toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  / {freeLimit.toLocaleString()}
                </Text>
              </View>
            </View>
            {paidCredits > 0 && (
              <View className="flex-row items-baseline justify-between pl-6">
                <Text className="text-sm text-muted-foreground">
                  {t('credits.paidCredits')}
                </Text>
                <Text className="text-base font-semibold text-foreground">
                  {paidCredits.toLocaleString()}
                </Text>
              </View>
            )}
          </View>

          {/* Subscription Info */}
          {isSubscribed && (
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <Crown size={18} className="text-foreground" />
                <Text className="text-sm font-semibold text-foreground">
                  {t('credits.subscription')}
                </Text>
              </View>
              <View className="pl-6 gap-1">
                <View className="flex-row items-baseline justify-between">
                  <Text className="text-sm text-muted-foreground">
                    {subscription.plan.name}
                  </Text>
                  <Text className="text-base font-semibold text-foreground">
                    ${(subscription.plan.price / 100).toFixed(2)}{t('credits.perMonth')}
                  </Text>
                </View>
                <Text className="text-xs text-muted-foreground">
                  {t('credits.creditsPerMonth', { count: subscription.plan.creditsPerMonth.toLocaleString() })}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {subscription.cancelAtPeriodEnd
                    ? t('credits.cancelsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })
                    : t('credits.renewsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })}
                </Text>
              </View>
            </View>
          )}

          {/* Daily Refresh */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Calendar size={18} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                {t('credits.dailyRefresh')}
              </Text>
            </View>
            <View className="flex-row items-baseline justify-between pl-6">
              <Text className="text-sm text-muted-foreground">{t('credits.atMidnight')}</Text>
              <Text className="text-2xl font-bold text-foreground">
                {dailyRefresh}
              </Text>
            </View>
          </View>
        </View>

        {/* Usage Chart */}
        <View className="px-4 pb-4">
          <View className="border border-border rounded-xl p-3">
            <Text className="text-xs font-medium text-muted-foreground mb-2">
              {t('credits.creditUsage')}
            </Text>
            <UsageChart />
          </View>
        </View>

        {/* View Usage Link */}
        <View className="px-4 pb-4">
          <Pressable
            onPress={() => navigate("/(app)/billing")}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Text className="text-sm font-medium text-primary">
              {t('credits.viewFullHistory')}
            </Text>
            <Text className="text-sm text-primary">&rsaquo;</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
