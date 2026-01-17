import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useEffect } from "react";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useRouter } from "expo-router";
import { Code, Key, Activity, Plus, ChevronRight, Zap, Package } from "lucide-react-native";
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
      <View className="px-4 py-3 border-b border-border">
        <View className="flex-row items-center mb-2">
          <View className="w-10 h-10 rounded-lg bg-primary/10 items-center justify-center mr-3">
            <Code size={20} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-xl font-bold text-foreground">Developer Portal</Text>
            <Text className="text-sm text-muted-foreground">Build apps powered by Alia AI</Text>
          </View>
        </View>

        {/* Create App Button */}
        <Button onPress={handleCreateApp} className="mt-2" size="sm">
          <Plus size={16} className="text-primary-foreground mr-1" />
          <Text className="text-primary-foreground font-semibold text-sm">Create New App</Text>
        </Button>
      </View>

      {/* Stats Overview */}
      {developerStats && (
        <View className="px-4 py-3">
          <Text className="text-sm font-semibold text-foreground mb-2">Overview</Text>
          <View className="flex-row flex-wrap -mx-1.5">
            {/* Total Apps */}
            <View className="w-1/2 px-1.5 mb-2">
              <Card className="p-3">
                <View className="flex-row items-center justify-between mb-1">
                  <Package size={16} className="text-primary" />
                  <Text className="text-xl font-bold text-foreground">
                    {developerStats.totalApps}
                  </Text>
                </View>
                <Text className="text-xs text-muted-foreground">Total Apps</Text>
                <Text className="text-xs text-muted-foreground/80">
                  {developerStats.activeApps} active
                </Text>
              </Card>
            </View>

            {/* API Keys */}
            <View className="w-1/2 px-1.5 mb-2">
              <Card className="p-3">
                <View className="flex-row items-center justify-between mb-1">
                  <Key size={16} className="text-primary" />
                  <Text className="text-xl font-bold text-foreground">
                    {developerStats.totalKeys}
                  </Text>
                </View>
                <Text className="text-xs text-muted-foreground">API Keys</Text>
                <Text className="text-xs text-muted-foreground/80">
                  {developerStats.activeKeys} active
                </Text>
              </Card>
            </View>

            {/* Requests */}
            <View className="w-1/2 px-1.5 mb-2">
              <Card className="p-3">
                <View className="flex-row items-center justify-between mb-1">
                  <Activity size={16} className="text-primary" />
                  <Text className="text-xl font-bold text-foreground">
                    {developerStats.last30Days.totalRequests.toLocaleString()}
                  </Text>
                </View>
                <Text className="text-xs text-muted-foreground">Requests</Text>
                <Text className="text-xs text-muted-foreground/80">Last 30 days</Text>
              </Card>
            </View>

            {/* Tokens */}
            <View className="w-1/2 px-1.5 mb-2">
              <Card className="p-3">
                <View className="flex-row items-center justify-between mb-1">
                  <Zap size={16} className="text-primary" />
                  <Text className="text-xl font-bold text-foreground">
                    {(developerStats.last30Days.totalTokens / 1000).toFixed(1)}K
                  </Text>
                </View>
                <Text className="text-xs text-muted-foreground">Tokens</Text>
                <Text className="text-xs text-muted-foreground/80">Last 30 days</Text>
              </Card>
            </View>
          </View>
        </View>
      )}

      {/* Quick Links */}
      <View className="px-4 py-3 border-t border-border">
        <Text className="text-sm font-semibold text-foreground mb-2">Quick Links</Text>
        <View className="gap-2">
          <Pressable
            onPress={() => router.push("/developers/documentation")}
            className="active:opacity-70"
          >
            <Card className="p-3">
              <View className="flex-row items-center justify-between">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">
                    API Documentation
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    Learn how to integrate Alia AI
                  </Text>
                </View>
                <ChevronRight size={16} className="text-muted-foreground ml-2" />
              </View>
            </Card>
          </Pressable>

          <Pressable
            onPress={() => router.push("/developers/examples")}
            className="active:opacity-70"
          >
            <Card className="p-3">
              <View className="flex-row items-center justify-between">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">
                    Code Examples
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    Browse sample code and guides
                  </Text>
                </View>
                <ChevronRight size={16} className="text-muted-foreground ml-2" />
              </View>
            </Card>
          </Pressable>
        </View>
      </View>

      {/* My Apps List */}
      <View className="px-4 py-3 border-t border-border">
        <Text className="text-sm font-semibold text-foreground mb-2">My Apps</Text>

        {isLoadingApps ? (
          <View className="py-6">
            <Text className="text-center text-sm text-muted-foreground">Loading apps...</Text>
          </View>
        ) : apps.length === 0 ? (
          <Card className="p-6">
            <View className="items-center">
              <View className="w-12 h-12 rounded-full bg-muted items-center justify-center mb-2">
                <Package size={24} className="text-muted-foreground" />
              </View>
              <Text className="text-sm font-semibold text-foreground mb-1">
                No apps yet
              </Text>
              <Text className="text-xs text-muted-foreground text-center mb-3">
                Create your first app to start building
              </Text>
              <Button onPress={handleCreateApp} size="sm">
                <Plus size={14} className="text-primary-foreground mr-1" />
                <Text className="text-primary-foreground font-semibold text-sm">Create App</Text>
              </Button>
            </View>
          </Card>
        ) : (
          <View className="gap-2">
            {apps.map((app) => (
              <Pressable
                key={app._id}
                onPress={() => handleViewApp(app._id)}
                className="active:opacity-70"
              >
                <Card className="p-3">
                  <View className="flex-row items-start">
                    <View className="w-10 h-10 rounded-lg bg-primary/10 items-center justify-center mr-2">
                      <Package size={20} className="text-primary" />
                    </View>
                    <View className="flex-1">
                      <View className="flex-row items-center mb-0.5">
                        <Text className="text-sm font-semibold text-foreground flex-1">
                          {app.name}
                        </Text>
                        {app.isActive ? (
                          <View className="px-1.5 py-0.5 rounded-full bg-green-500/10">
                            <Text className="text-xs font-medium text-green-600">Active</Text>
                          </View>
                        ) : (
                          <View className="px-1.5 py-0.5 rounded-full bg-gray-500/10">
                            <Text className="text-xs font-medium text-gray-600">Inactive</Text>
                          </View>
                        )}
                      </View>
                      {app.description && (
                        <Text className="text-xs text-muted-foreground mb-1" numberOfLines={2}>
                          {app.description}
                        </Text>
                      )}
                      <Text className="text-xs text-muted-foreground/80">
                        Created {new Date(app.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <ChevronRight size={16} className="text-muted-foreground ml-2" />
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
