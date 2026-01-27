import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useRouter } from "expo-router";
import { ArrowLeft, RefreshCw, Activity, Zap, CheckCircle, XCircle } from "lucide-react-native";
import { useModelsStats } from "@/lib/hooks/use-developer";
import { useEffect } from "react";
import { useAuth } from "@oxyhq/services";

export default function DevelopersModelsScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: modelsData, isLoading, refetch } = useModelsStats();

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated]);

  const getCategoryName = (category: string) => {
    switch (category) {
      case 'general':
        return 'General';
      case 'coding':
        return 'Coding';
      case 'specialized':
        return 'Specialized';
      default:
        return category;
    }
  };

  const getHealthColor = (isHealthy: boolean) => {
    return isHealthy ? 'text-green-600' : 'text-red-600';
  };

  const getUptimeColor = (uptime: number) => {
    if (uptime >= 95) return 'text-green-600';
    if (uptime >= 80) return 'text-yellow-600';
    return 'text-red-600';
  };

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">Alia Models</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          View statistics and performance metrics for all Alia virtual models
        </Text>
      </View>

      {isLoading ? (
        <View className="px-6 py-6">
          <Text className="text-sm text-muted-foreground">Loading models...</Text>
        </View>
      ) : modelsData ? (
        <>
          {/* Summary Stats */}
          <View className="px-6 py-6 border-b border-border">
            <Text className="text-sm font-semibold text-foreground mb-4">Overview</Text>
            <View className="flex-row gap-12">
              <View>
                <Text className="text-2xl font-semibold text-foreground">
                  {modelsData.count}
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">Total models</Text>
              </View>
              <View>
                <Text className="text-2xl font-semibold text-foreground">
                  {modelsData.models.filter(m => m.isHealthy).length}
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">Healthy</Text>
              </View>
              <View>
                <Text className="text-2xl font-semibold text-foreground">
                  {modelsData.models.reduce((sum, m) => sum + m.totalRequests, 0).toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">Total requests</Text>
              </View>
            </View>
          </View>

          {/* Models by Category */}
          {['general', 'coding', 'specialized'].map((category) => {
            const categoryModels = modelsData.models.filter(m => m.category === category);
            if (categoryModels.length === 0) return null;

            return (
              <View key={category} className="px-6 py-6 border-b border-border">
                <Text className="text-sm font-semibold text-foreground mb-4">
                  {getCategoryName(category)} Models
                </Text>

                <View>
                  {categoryModels.map((model, index) => (
                    <View
                      key={model.id}
                      className={`py-4 ${
                        index < categoryModels.length - 1 ? 'border-b border-border' : ''
                      }`}
                    >
                      {/* Model Header */}
                      <View className="flex-row items-center justify-between mb-2">
                        <View className="flex-1">
                          <View className="flex-row items-center gap-2 mb-1">
                            <Text className="text-base font-semibold text-foreground">
                              {model.name}
                            </Text>
                            {model.isHealthy ? (
                              <CheckCircle size={16} className="text-green-600" />
                            ) : (
                              <XCircle size={16} className="text-red-600" />
                            )}
                          </View>
                          <Text className="text-sm text-muted-foreground">
                            {model.description}
                          </Text>
                        </View>
                      </View>

                      {/* Capabilities */}
                      <View className="flex-row gap-2 mb-3">
                        {model.supportsTools && (
                          <View className="px-2 py-1 rounded bg-blue-100">
                            <Text className="text-xs font-medium text-blue-700">Tools</Text>
                          </View>
                        )}
                        {model.supportsVision && (
                          <View className="px-2 py-1 rounded bg-purple-100">
                            <Text className="text-xs font-medium text-purple-700">Vision</Text>
                          </View>
                        )}
                        <View className="px-2 py-1 rounded bg-gray-100">
                          <Text className="text-xs font-medium text-gray-700">
                            {model.maxTokens.toLocaleString()} tokens
                          </Text>
                        </View>
                      </View>

                      {/* Stats Grid */}
                      <View className="flex-row flex-wrap gap-4">
                        <View className="flex-1 min-w-[100px]">
                          <Text className="text-xs text-muted-foreground mb-0.5">Avg Latency</Text>
                          <View className="flex-row items-center gap-1">
                            <Zap size={14} className="text-foreground" />
                            <Text className="text-sm font-medium text-foreground">
                              {model.avgLatencyMs}ms
                            </Text>
                          </View>
                        </View>

                        <View className="flex-1 min-w-[100px]">
                          <Text className="text-xs text-muted-foreground mb-0.5">Uptime</Text>
                          <View className="flex-row items-center gap-1">
                            <Activity size={14} className={getUptimeColor(model.uptime)} />
                            <Text className={`text-sm font-medium ${getUptimeColor(model.uptime)}`}>
                              {model.uptime.toFixed(1)}%
                            </Text>
                          </View>
                        </View>

                        <View className="flex-1 min-w-[100px]">
                          <Text className="text-xs text-muted-foreground mb-0.5">Success Rate</Text>
                          <Text className="text-sm font-medium text-foreground">
                            {model.successRate.toFixed(1)}%
                          </Text>
                        </View>

                        <View className="flex-1 min-w-[100px]">
                          <Text className="text-xs text-muted-foreground mb-0.5">Requests</Text>
                          <Text className="text-sm font-medium text-foreground">
                            {model.totalRequests.toLocaleString()}
                          </Text>
                        </View>

                        <View className="flex-1 min-w-[100px]">
                          <Text className="text-xs text-muted-foreground mb-0.5">Credits</Text>
                          <Text className="text-sm font-medium text-foreground">
                            {model.creditMultiplier}x
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            );
          })}

          {/* Last Updated */}
          <View className="px-6 py-6 border-b border-border">
            <View className="flex-row items-center justify-between">
              <View>
                <Text className="text-sm font-semibold text-foreground mb-1">Last updated</Text>
                <Text className="text-sm text-muted-foreground">
                  {new Date(modelsData.timestamp).toLocaleString()}
                </Text>
              </View>
              <Pressable
                onPress={() => refetch()}
                className="flex-row items-center justify-center py-2 px-4 rounded-md border border-border bg-background active:opacity-70"
              >
                <RefreshCw size={16} className="text-foreground mr-2" />
                <Text className="text-sm font-medium text-foreground">Refresh</Text>
              </Pressable>
            </View>
          </View>

          {/* Info */}
          <View className="px-6 py-6">
            <Text className="text-sm font-semibold text-foreground mb-4">About model stats</Text>

            <View className="mb-3">
              <Text className="text-sm text-foreground mb-1">• Virtual models</Text>
              <Text className="text-sm text-muted-foreground ml-4">
                Each Alia model is backed by multiple provider models for reliability and performance
              </Text>
            </View>

            <View className="mb-3">
              <Text className="text-sm text-foreground mb-1">• Aggregated metrics</Text>
              <Text className="text-sm text-muted-foreground ml-4">
                Statistics combine data from all backing providers to show overall model performance
              </Text>
            </View>

            <View>
              <Text className="text-sm text-foreground mb-1">• Real-time health</Text>
              <Text className="text-sm text-muted-foreground ml-4">
                Health status updates in real-time based on recent request success rates
              </Text>
            </View>
          </View>
        </>
      ) : (
        <View className="px-6 py-6">
          <Text className="text-sm text-muted-foreground">Failed to load model statistics</Text>
        </View>
      )}
    </ScrollView>
  );
}
