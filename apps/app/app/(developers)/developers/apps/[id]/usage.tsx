import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Card } from "@/components/ui/card";
import { useState, useEffect } from "react";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Activity, TrendingUp, Zap, CheckCircle, XCircle, Clock } from "lucide-react-native";
import { useApp, useAppUsage } from "@/lib/hooks/use-developer";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";

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
      <View className="px-6 py-4 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={20} className="text-muted-foreground mr-2" />
          <Text className="text-base text-muted-foreground">Back</Text>
        </Pressable>

        <View className="flex-row items-center">
          <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center mr-4">
            <Activity size={28} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-3xl font-bold text-foreground">Usage Statistics</Text>
            {currentApp && (
              <Text className="text-base text-muted-foreground mt-1">
                {currentApp.name}
              </Text>
            )}
          </View>
        </View>
      </View>

      {/* Period Selector */}
      <View className="px-6 py-4">
        <ToggleGroup
          value={period}
          onValueChange={(value) => value && setPeriod(value)}
          type="single"
          className="flex-row justify-between"
        >
          <ToggleGroupItem value="24h" aria-label="Last 24 hours" className="flex-1">
            <Text className={period === "24h" ? "text-primary" : "text-muted-foreground"}>
              24h
            </Text>
          </ToggleGroupItem>
          <ToggleGroupItem value="7d" aria-label="Last 7 days" className="flex-1">
            <Text className={period === "7d" ? "text-primary" : "text-muted-foreground"}>
              7d
            </Text>
          </ToggleGroupItem>
          <ToggleGroupItem value="30d" aria-label="Last 30 days" className="flex-1">
            <Text className={period === "30d" ? "text-primary" : "text-muted-foreground"}>
              30d
            </Text>
          </ToggleGroupItem>
          <ToggleGroupItem value="90d" aria-label="Last 90 days" className="flex-1">
            <Text className={period === "90d" ? "text-primary" : "text-muted-foreground"}>
              90d
            </Text>
          </ToggleGroupItem>
        </ToggleGroup>
      </View>

      {isLoadingUsage ? (
        <View className="px-6 py-8">
          <Text className="text-center text-muted-foreground">Loading usage data...</Text>
        </View>
      ) : summary ? (
        <>
          {/* Summary Stats */}
          <View className="px-6 py-4">
            <Text className="text-lg font-semibold text-foreground mb-4">Overview</Text>
            <View className="flex-row flex-wrap -mx-2">
              {/* Total Requests */}
              <View className="w-1/2 px-2 mb-4">
                <Card className="p-4">
                  <View className="flex-row items-center justify-between mb-2">
                    <TrendingUp size={20} className="text-primary" />
                    <Text className="text-2xl font-bold text-foreground">
                      {summary.totalRequests.toLocaleString()}
                    </Text>
                  </View>
                  <Text className="text-sm text-muted-foreground">Total Requests</Text>
                </Card>
              </View>

              {/* Total Tokens */}
              <View className="w-1/2 px-2 mb-4">
                <Card className="p-4">
                  <View className="flex-row items-center justify-between mb-2">
                    <Zap size={20} className="text-primary" />
                    <Text className="text-2xl font-bold text-foreground">
                      {(summary.totalTokens / 1000).toFixed(1)}K
                    </Text>
                  </View>
                  <Text className="text-sm text-muted-foreground">Tokens Used</Text>
                </Card>
              </View>

              {/* Successful Requests */}
              <View className="w-1/2 px-2 mb-4">
                <Card className="p-4">
                  <View className="flex-row items-center justify-between mb-2">
                    <CheckCircle size={20} className="text-green-600" />
                    <Text className="text-2xl font-bold text-foreground">
                      {summary.successfulRequests.toLocaleString()}
                    </Text>
                  </View>
                  <Text className="text-sm text-muted-foreground">Successful</Text>
                  <Text className="text-xs text-muted-foreground mt-1">
                    {summary.totalRequests > 0
                      ? ((summary.successfulRequests / summary.totalRequests) * 100).toFixed(1)
                      : "0"}% success rate
                  </Text>
                </Card>
              </View>

              {/* Failed Requests */}
              <View className="w-1/2 px-2 mb-4">
                <Card className="p-4">
                  <View className="flex-row items-center justify-between mb-2">
                    <XCircle size={20} className="text-destructive" />
                    <Text className="text-2xl font-bold text-foreground">
                      {summary.errorRequests.toLocaleString()}
                    </Text>
                  </View>
                  <Text className="text-sm text-muted-foreground">Errors</Text>
                  <Text className="text-xs text-muted-foreground mt-1">
                    {summary.totalRequests > 0
                      ? ((summary.errorRequests / summary.totalRequests) * 100).toFixed(1)
                      : "0"}% error rate
                  </Text>
                </Card>
              </View>

              {/* Avg Response Time */}
              <View className="w-full px-2 mb-4">
                <Card className="p-4">
                  <View className="flex-row items-center justify-between mb-2">
                    <Clock size={20} className="text-primary" />
                    <Text className="text-2xl font-bold text-foreground">
                      {summary.avgResponseTime ? summary.avgResponseTime.toFixed(0) : "0"}ms
                    </Text>
                  </View>
                  <Text className="text-sm text-muted-foreground">Avg Response Time</Text>
                </Card>
              </View>
            </View>
          </View>

          {/* Usage by Day */}
          {byDay.length > 0 && (
            <View className="px-6 py-4 border-t border-border">
              <Text className="text-lg font-semibold text-foreground mb-4">Daily Usage</Text>
              <Card className="p-4">
                {byDay.map((day, index) => (
                  <View
                    key={day._id}
                    className={`py-3 ${index < byDay.length - 1 ? "border-b border-border" : ""}`}
                  >
                    <View className="flex-row items-center justify-between mb-1">
                      <Text className="text-sm font-medium text-foreground">
                        {new Date(day._id).toLocaleDateString()}
                      </Text>
                      <Text className="text-sm font-semibold text-primary">
                        {day.requests.toLocaleString()} requests
                      </Text>
                    </View>
                    <View className="flex-row items-center justify-between">
                      <Text className="text-xs text-muted-foreground">
                        {(day.tokens / 1000).toFixed(1)}K tokens
                      </Text>
                      {day.credits > 0 && (
                        <Text className="text-xs text-muted-foreground">
                          {day.credits} credits
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </Card>
            </View>
          )}

          {/* Top Endpoints */}
          {byEndpoint.length > 0 && (
            <View className="px-6 py-4 border-t border-border">
              <Text className="text-lg font-semibold text-foreground mb-4">Top Endpoints</Text>
              <Card className="p-4">
                {byEndpoint.map((endpoint, index) => (
                  <View
                    key={endpoint._id}
                    className={`py-3 ${index < byEndpoint.length - 1 ? "border-b border-border" : ""}`}
                  >
                    <View className="flex-row items-center justify-between mb-1">
                      <Text className="text-sm font-mono text-foreground flex-1" numberOfLines={1}>
                        {endpoint._id}
                      </Text>
                      <Text className="text-sm font-semibold text-primary ml-2">
                        {endpoint.requests.toLocaleString()}
                      </Text>
                    </View>
                    <Text className="text-xs text-muted-foreground">
                      {(endpoint.tokens / 1000).toFixed(1)}K tokens
                    </Text>
                  </View>
                ))}
              </Card>
            </View>
          )}
        </>
      ) : (
        <View className="px-6 py-8">
          <Card className="p-8">
            <View className="items-center">
              <Activity size={32} className="text-muted-foreground mb-2" />
              <Text className="text-base text-muted-foreground text-center">
                No usage data available for this period
              </Text>
            </View>
          </Card>
        </View>
      )}
    </ScrollView>
  );
}
