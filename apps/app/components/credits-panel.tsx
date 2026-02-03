import { useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Sparkles, Calendar, X } from "lucide-react-native";
import { useCredits, useCreditsUsage } from "@/lib/hooks/use-credits";
import { useRouter } from "expo-router";
import { useUIStore } from "@/lib/stores/ui-store";

type ChartPeriod = "7d" | "30d";

const DAY_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function formatDayLabel(dateStr: string, isLast: boolean): string {
  if (isLast) return "Hoy";
  const d = new Date(dateStr + "T00:00:00");
  return DAY_LABELS[d.getDay()];
}

function UsageChart() {
  const [period, setPeriod] = useState<ChartPeriod>("7d");
  const { data: usageData } = useCreditsUsage(period);

  const items = usageData ?? [];
  const maxValue = items.length > 0 ? Math.max(...items.map((d) => d.used)) : 0;
  const totalUsed = items.reduce((acc, d) => acc + d.used, 0);

  return (
    <View className="gap-3">
      {/* Chart Header */}
      <View className="flex-row items-center justify-between">
        <View>
          <Text className="text-xs text-muted-foreground">Uso total</Text>
          <Text className="text-lg font-bold text-foreground">
            {totalUsed.toLocaleString()}
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

      {/* Bars */}
      <View className="flex-row items-end gap-1.5" style={{ height: 100 }}>
        {items.map((item, i) => {
          const barHeight = maxValue > 0 ? (item.used / maxValue) * 100 : 0;
          const isLast = i === items.length - 1;
          const label = period === "7d"
            ? formatDayLabel(item.date, isLast)
            : (i % 5 === 0 || isLast ? item.date.slice(5) : "");
          return (
            <View key={item.date} className="flex-1 items-center gap-1.5">
              <View
                className="w-full items-center justify-end"
                style={{ height: 80 }}
              >
                <View
                  className={`w-full rounded-t-sm ${
                    isLast ? "bg-primary" : "bg-primary/30"
                  }`}
                  style={{
                    height: `${Math.max(barHeight, 4)}%`,
                    minHeight: 3,
                  }}
                />
              </View>
              <Text
                className={`text-[10px] ${
                  isLast
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
                }`}
              >
                {label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function CreditsPanel() {
  const router = useRouter();
  const { data } = useCredits();
  const setRightPanel = useUIStore((state) => state.setRightPanel);

  const credits = data?.credits ?? 0;
  const freeCredits = data?.freeCredits ?? 0;
  const dailyRefresh = data?.dailyRefresh ?? 0;

  const handleUpgrade = () => {
    setRightPanel(null);
    router.push("/(app)/billing");
  };

  const handleViewUsage = () => {
    setRightPanel(null);
    router.push("/(app)/billing");
  };

  const handleClose = () => {
    setRightPanel(null);
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <Text className="text-base font-semibold text-foreground">
          Créditos
        </Text>
        <Pressable
          className="p-1 rounded-lg active:opacity-70"
          onPress={handleClose}
        >
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/* Plan Badge & Upgrade */}
        <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
          <View className="flex-row items-center gap-2">
            <View className="px-2 py-0.5 rounded-full bg-muted">
              <Text className="text-xs font-medium text-muted-foreground">
                Free
              </Text>
            </View>
          </View>
          <Button onPress={handleUpgrade} className="h-8 px-4 rounded-full">
            <Text className="text-sm font-medium text-primary-foreground">
              Upgrade
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
                Créditos
              </Text>
            </View>
            <View className="flex-row items-baseline justify-between pl-6">
              <Text className="text-sm text-muted-foreground">
                Créditos gratis
              </Text>
              <View className="flex-row items-baseline gap-1">
                <Text className="text-2xl font-bold text-foreground">
                  {credits.toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  / {freeCredits.toLocaleString()}
                </Text>
              </View>
            </View>
          </View>

          {/* Daily Refresh */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Calendar size={18} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Recarga diaria
              </Text>
            </View>
            <View className="flex-row items-baseline justify-between pl-6">
              <Text className="text-sm text-muted-foreground">a las 00:00</Text>
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
              Uso de créditos
            </Text>
            <UsageChart />
          </View>
        </View>

        {/* View Usage Link */}
        <View className="px-4 pb-4">
          <Pressable
            onPress={handleViewUsage}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Text className="text-sm font-medium text-primary">
              Ver historial completo
            </Text>
            <Text className="text-sm text-primary">›</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
