import { useState, useEffect } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { BarChart3, TrendingUp, Zap, Clock } from 'lucide-react-native';
import apiClient from '@/lib/api/client';

interface UsageDay {
  _id: string;
  conversations: number;
  totalTokens: number;
  avgLatency: number;
}

interface ModelUsage {
  _id: string;
  count: number;
  totalTokens: number;
  avgLatency: number;
}

export default function AnalyticsScreen() {
  const [usage, setUsage] = useState<UsageDay[]>([]);
  const [models, setModels] = useState<ModelUsage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAnalytics();
  }, []);

  async function loadAnalytics() {
    try {
      const [usageRes, modelsRes] = await Promise.all([
        apiClient.get('/analytics/usage?days=30'),
        apiClient.get('/analytics/models?days=30'),
      ]);
      setUsage(usageRes.data.usage);
      setModels(modelsRes.data.models);
    } catch (error) {
      console.error('Failed to load analytics:', error);
    } finally {
      setLoading(false);
    }
  }

  const totalConversations = usage.reduce((sum, d) => sum + d.conversations, 0);
  const totalTokens = usage.reduce((sum, d) => sum + d.totalTokens, 0);
  const avgLatency = usage.length > 0 ? Math.round(usage.reduce((sum, d) => sum + d.avgLatency, 0) / usage.length) : 0;

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerClassName="pb-10">
        {/* Header */}
        <View className="px-6 pt-6 pb-4">
          <Text className="text-2xl font-bold text-foreground">Analytics</Text>
          <Text className="text-sm text-muted-foreground mt-1">Last 30 days</Text>
        </View>

        {/* Summary Cards */}
        <View className="flex-row flex-wrap px-6 gap-3 mb-6">
          <View className="flex-1 min-w-[45%] bg-surface border border-border rounded-xl p-4">
            <View className="flex-row items-center gap-2 mb-2">
              <BarChart3 size={16} className="text-primary" />
              <Text className="text-xs text-muted-foreground">Conversations</Text>
            </View>
            <Text className="text-2xl font-bold text-foreground">{totalConversations}</Text>
          </View>
          <View className="flex-1 min-w-[45%] bg-surface border border-border rounded-xl p-4">
            <View className="flex-row items-center gap-2 mb-2">
              <Zap size={16} className="text-primary" />
              <Text className="text-xs text-muted-foreground">Tokens Used</Text>
            </View>
            <Text className="text-2xl font-bold text-foreground">{(totalTokens / 1000).toFixed(1)}K</Text>
          </View>
          <View className="flex-1 min-w-[45%] bg-surface border border-border rounded-xl p-4">
            <View className="flex-row items-center gap-2 mb-2">
              <Clock size={16} className="text-primary" />
              <Text className="text-xs text-muted-foreground">Avg Latency</Text>
            </View>
            <Text className="text-2xl font-bold text-foreground">{avgLatency}ms</Text>
          </View>
          <View className="flex-1 min-w-[45%] bg-surface border border-border rounded-xl p-4">
            <View className="flex-row items-center gap-2 mb-2">
              <TrendingUp size={16} className="text-primary" />
              <Text className="text-xs text-muted-foreground">Models Used</Text>
            </View>
            <Text className="text-2xl font-bold text-foreground">{models.length}</Text>
          </View>
        </View>

        {/* Model Breakdown */}
        <View className="px-6 mb-6">
          <Text className="text-lg font-semibold text-foreground mb-3">Model Usage</Text>
          {models.map((model) => (
            <View key={model._id} className="flex-row items-center justify-between py-3 border-b border-border">
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">{model._id}</Text>
                <Text className="text-xs text-muted-foreground">{model.count} conversations</Text>
              </View>
              <Text className="text-sm text-muted-foreground">{(model.totalTokens / 1000).toFixed(1)}K tokens</Text>
            </View>
          ))}
          {models.length === 0 && !loading && (
            <Text className="text-sm text-muted-foreground text-center py-8">No data yet. Start chatting to see analytics!</Text>
          )}
        </View>

        {/* Daily Activity */}
        <View className="px-6">
          <Text className="text-lg font-semibold text-foreground mb-3">Daily Activity</Text>
          {usage.slice(-7).map((day) => (
            <View key={day._id} className="flex-row items-center justify-between py-3 border-b border-border">
              <Text className="text-sm text-foreground">{day._id}</Text>
              <View className="flex-row items-center gap-4">
                <Text className="text-xs text-muted-foreground">{day.conversations} chats</Text>
                <Text className="text-xs text-muted-foreground">{(day.totalTokens / 1000).toFixed(1)}K tokens</Text>
              </View>
            </View>
          ))}
          {usage.length === 0 && !loading && (
            <Text className="text-sm text-muted-foreground text-center py-8">No activity data yet.</Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
