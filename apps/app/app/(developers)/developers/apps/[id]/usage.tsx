import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useState } from "react";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useApp, useAppUsage } from "@/lib/hooks/use-developer";

export default function AppUsageScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: currentApp } = useApp(id!);
  const [period, setPeriod] = useState<string>("7d");
  const { data: usageStats, isLoading: isLoadingUsage } = useAppUsage(id!, period);

  const summary = usageStats?.summary;
  const byDay = usageStats?.byDay || [];
  const byEndpoint = usageStats?.byEndpoint || [];

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">Usage statistics</Text>
        {currentApp && (
          <Text className="text-sm text-muted-foreground mt-1">
            {currentApp.name}
          </Text>
        )}
      </View>

      {/* Period Selector */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Time period</Text>
        <View className="flex-row gap-2">
          {[
            { value: "24h", label: "24 hours" },
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
            { value: "90d", label: "90 days" },
          ].map((option) => (
            <Pressable
              key={option.value}
              onPress={() => setPeriod(option.value)}
              className={`px-3 py-2 rounded-md border ${
                period === option.value
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background"
              }`}
            >
              <Text
                className={`text-sm font-medium ${
                  period === option.value ? "text-primary" : "text-foreground"
                }`}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {isLoadingUsage ? (
        <View className="px-6 py-6">
          <Text className="text-sm text-muted-foreground">Loading statistics...</Text>
        </View>
      ) : summary ? (
        <>
          {/* Summary Stats */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">Summary</Text>
            <View className="flex-row gap-8">
              <View>
                <Text className="text-2xl font-semibold text-foreground">
                  {summary.totalRequests.toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">Total requests</Text>
              </View>
              <View>
                <Text className="text-2xl font-semibold text-foreground">
                  {summary.successfulRequests.toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">Successful</Text>
              </View>
              <View>
                <Text className="text-2xl font-semibold text-foreground">
                  {summary.errorRequests.toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">Errors</Text>
              </View>
            </View>
          </View>

          {/* Tokens & Performance */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">Performance</Text>
            <View className="mb-4">
              <Text className="text-sm text-muted-foreground mb-1">Tokens used</Text>
              <Text className="text-sm text-foreground">
                {summary.totalTokens.toLocaleString()}
              </Text>
            </View>
            <View>
              <Text className="text-sm text-muted-foreground mb-1">Avg response time</Text>
              <Text className="text-sm text-foreground">
                {summary.avgResponseTime ? `${summary.avgResponseTime.toFixed(0)}ms` : "N/A"}
              </Text>
            </View>
          </View>

          {/* Top Endpoints */}
          {byEndpoint.length > 0 && (
            <View className="px-6 py-6 border-b border-border">
              <Text className="text-sm font-semibold text-foreground mb-4">Top endpoints</Text>
              <View>
                {byEndpoint.map((endpoint, index) => (
                  <View
                    key={endpoint._id}
                    className={`py-3 ${index < byEndpoint.length - 1 ? "border-b border-border" : ""}`}
                  >
                    <View className="flex-row items-center justify-between mb-1">
                      <Text className="text-sm font-medium text-foreground font-mono">
                        {endpoint._id}
                      </Text>
                      <Text className="text-sm text-muted-foreground">
                        {endpoint.requests.toLocaleString()} requests
                      </Text>
                    </View>
                    <Text className="text-sm text-muted-foreground">
                      {endpoint.tokens.toLocaleString()} tokens
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Daily Usage */}
          {byDay.length > 0 && (
            <View className="px-6 py-6">
              <Text className="text-sm font-semibold text-foreground mb-4">Daily usage</Text>
              <View>
                {byDay.map((day, index) => (
                  <View
                    key={day._id}
                    className={`py-3 ${index < byDay.length - 1 ? "border-b border-border" : ""}`}
                  >
                    <View className="flex-row items-center justify-between mb-1">
                      <Text className="text-sm font-medium text-foreground">{day._id}</Text>
                      <Text className="text-sm text-muted-foreground">
                        {day.requests.toLocaleString()} requests
                      </Text>
                    </View>
                    <Text className="text-sm text-muted-foreground">
                      {day.tokens.toLocaleString()} tokens
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </>
      ) : (
        <View className="px-6 py-6">
          <Text className="text-sm text-muted-foreground">No usage data available for this period.</Text>
        </View>
      )}
    </ScrollView>
  );
}
