import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useEffect } from "react";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useRouter } from "expo-router";
import { Code, Key, Activity, Plus, ChevronRight, Zap, TrendingUp, Package } from "lucide-react-native";
import { useApps, useDeveloperStats } from "@/lib/hooks/use-developer";

export default function DeveloperPortalScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();
  const { data: apps = [], isLoading: isLoadingApps } = useApps();
  const { data: developerStats, isLoading: isLoadingStats } = useDeveloperStats();

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated]);

  const handleCreateApp = () => {
    router.push("/developers/apps/new");
  };

  const handleViewApp = (appId: string) => {
    router.push(`/developers/apps/${appId}`);
  };

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Hero Section */}
      <View className="px-6 py-8 border-b border-border">
        <View className="flex-row items-center mb-3">
          <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center mr-4">
            <Code size={28} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-3xl font-bold text-foreground">Developer Portal</Text>
            <Text className="text-base text-muted-foreground mt-1">
              Build apps powered by Alia AI
            </Text>
          </View>
        </View>

        {/* Create App Button */}
        <Button
          onPress={handleCreateApp}
          className="mt-4"
        >
          <Plus size={20} className="text-primary-foreground mr-2" />
          <Text className="text-primary-foreground font-semibold">Create New App</Text>
        </Button>
      </View>

      {/* Stats Overview */}
      {developerStats && (
        <View className="px-6 py-6">
          <Text className="text-lg font-semibold text-foreground mb-4">Overview</Text>
          <View className="flex-row flex-wrap -mx-2">
            {/* Total Apps */}
            <View className="w-1/2 px-2 mb-4">
              <Card className="p-4">
                <View className="flex-row items-center justify-between mb-2">
                  <Package size={20} className="text-primary" />
                  <Text className="text-2xl font-bold text-foreground">
                    {developerStats.totalApps}
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">Total Apps</Text>
                <Text className="text-xs text-muted-foreground mt-1">
                  {developerStats.activeApps} active
                </Text>
              </Card>
            </View>

            {/* API Keys */}
            <View className="w-1/2 px-2 mb-4">
              <Card className="p-4">
                <View className="flex-row items-center justify-between mb-2">
                  <Key size={20} className="text-primary" />
                  <Text className="text-2xl font-bold text-foreground">
                    {developerStats.totalKeys}
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">API Keys</Text>
                <Text className="text-xs text-muted-foreground mt-1">
                  {developerStats.activeKeys} active
                </Text>
              </Card>
            </View>

            {/* Requests (Last 30 Days) */}
            <View className="w-1/2 px-2 mb-4">
              <Card className="p-4">
                <View className="flex-row items-center justify-between mb-2">
                  <Activity size={20} className="text-primary" />
                  <Text className="text-2xl font-bold text-foreground">
                    {developerStats.last30Days.totalRequests.toLocaleString()}
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">Requests</Text>
                <Text className="text-xs text-muted-foreground mt-1">Last 30 days</Text>
              </Card>
            </View>

            {/* Tokens Used */}
            <View className="w-1/2 px-2 mb-4">
              <Card className="p-4">
                <View className="flex-row items-center justify-between mb-2">
                  <Zap size={20} className="text-primary" />
                  <Text className="text-2xl font-bold text-foreground">
                    {(developerStats.last30Days.totalTokens / 1000).toFixed(1)}K
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">Tokens</Text>
                <Text className="text-xs text-muted-foreground mt-1">Last 30 days</Text>
              </Card>
            </View>
          </View>
        </View>
      )}

      {/* Quick Links */}
      <View className="px-6 py-6 border-t border-border">
        <Text className="text-lg font-semibold text-foreground mb-4">Quick Links</Text>
        <View className="space-y-3">
          <Pressable
            onPress={() => router.push("/developers/documentation")}
            className="active:opacity-70"
          >
            <Card className="p-4">
              <View className="flex-row items-center justify-between">
                <View className="flex-1">
                  <Text className="text-base font-semibold text-foreground mb-1">
                    API Documentation
                  </Text>
                  <Text className="text-sm text-muted-foreground">
                    Learn how to integrate Alia AI into your apps
                  </Text>
                </View>
                <ChevronRight size={20} className="text-muted-foreground ml-2" />
              </View>
            </Card>
          </Pressable>

          <Pressable
            onPress={() => router.push("/developers/examples")}
            className="active:opacity-70"
          >
            <Card className="p-4">
              <View className="flex-row items-center justify-between">
                <View className="flex-1">
                  <Text className="text-base font-semibold text-foreground mb-1">
                    Code Examples
                  </Text>
                  <Text className="text-sm text-muted-foreground">
                    Browse sample code and integration guides
                  </Text>
                </View>
                <ChevronRight size={20} className="text-muted-foreground ml-2" />
              </View>
            </Card>
          </Pressable>
        </View>
      </View>

      {/* My Apps List */}
      <View className="px-6 py-6 border-t border-border">
        <Text className="text-lg font-semibold text-foreground mb-4">My Apps</Text>

        {isLoadingApps ? (
          <View className="py-8">
            <Text className="text-center text-muted-foreground">Loading apps...</Text>
          </View>
        ) : apps.length === 0 ? (
          <Card className="p-8">
            <View className="items-center">
              <View className="w-16 h-16 rounded-full bg-muted items-center justify-center mb-4">
                <Package size={32} className="text-muted-foreground" />
              </View>
              <Text className="text-lg font-semibold text-foreground mb-2">
                No apps yet
              </Text>
              <Text className="text-sm text-muted-foreground text-center mb-4">
                Create your first app to start building with Alia AI
              </Text>
              <Button onPress={handleCreateApp}>
                <Plus size={18} className="text-primary-foreground mr-2" />
                <Text className="text-primary-foreground font-semibold">Create App</Text>
              </Button>
            </View>
          </Card>
        ) : (
          <View className="space-y-3">
            {apps.map((app) => (
              <Pressable
                key={app._id}
                onPress={() => handleViewApp(app._id)}
                className="active:opacity-70"
              >
                <Card className="p-4">
                  <View className="flex-row items-start">
                    <View className="w-12 h-12 rounded-xl bg-primary/10 items-center justify-center mr-3">
                      <Package size={24} className="text-primary" />
                    </View>
                    <View className="flex-1">
                      <View className="flex-row items-center mb-1">
                        <Text className="text-base font-semibold text-foreground flex-1">
                          {app.name}
                        </Text>
                        {app.isActive ? (
                          <View className="px-2 py-1 rounded-full bg-green-500/10">
                            <Text className="text-xs font-medium text-green-600">Active</Text>
                          </View>
                        ) : (
                          <View className="px-2 py-1 rounded-full bg-gray-500/10">
                            <Text className="text-xs font-medium text-gray-600">Inactive</Text>
                          </View>
                        )}
                      </View>
                      {app.description && (
                        <Text className="text-sm text-muted-foreground mb-2" numberOfLines={2}>
                          {app.description}
                        </Text>
                      )}
                      <Text className="text-xs text-muted-foreground">
                        Created {new Date(app.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <ChevronRight size={20} className="text-muted-foreground ml-2" />
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
