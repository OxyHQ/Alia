import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useEffect } from "react";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useRouter } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { useApps, useDeveloperStats } from "@/lib/hooks/use-developer";

export default function DeveloperPortalScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();
  const { data: apps = [], isLoading: isLoadingApps } = useApps();
  const { data: developerStats } = useDeveloperStats();

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
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <View className="flex-row items-center justify-between mb-1">
          <Text className="text-2xl font-semibold text-foreground">Developer settings</Text>
          <Button onPress={handleCreateApp} size="sm">
            <Text className="text-primary-foreground font-medium text-sm">New app</Text>
          </Button>
        </View>
        <Text className="text-sm text-muted-foreground">
          Build applications powered by Alia AI
        </Text>
      </View>

      {/* Stats */}
      {developerStats && (
        <View className="px-6 py-6 border-b border-border">
          <Text className="text-sm font-semibold text-foreground mb-4">Usage</Text>
          <View className="flex-row gap-12">
            <View>
              <Text className="text-2xl font-semibold text-foreground">{developerStats.totalApps}</Text>
              <Text className="text-sm text-muted-foreground mt-0.5">Apps</Text>
            </View>
            <View>
              <Text className="text-2xl font-semibold text-foreground">{developerStats.totalKeys}</Text>
              <Text className="text-sm text-muted-foreground mt-0.5">API keys</Text>
            </View>
            <View>
              <Text className="text-2xl font-semibold text-foreground">
                {developerStats.last30Days.totalRequests.toLocaleString()}
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">Requests (30d)</Text>
            </View>
          </View>
        </View>
      )}

      {/* Resources */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Resources</Text>
        <View>
          <Pressable
            onPress={() => router.push("/developers/documentation")}
            className="flex-row items-center justify-between py-3 border-b border-border active:opacity-70"
          >
            <Text className="text-sm text-foreground">API documentation</Text>
            <ChevronRight size={16} className="text-muted-foreground" />
          </Pressable>
          <Pressable
            onPress={() => router.push("/developers/examples")}
            className="flex-row items-center justify-between py-3 border-b border-border active:opacity-70"
          >
            <Text className="text-sm text-foreground">Code examples</Text>
            <ChevronRight size={16} className="text-muted-foreground" />
          </Pressable>
          <Pressable
            onPress={() => router.push("/developers/billing")}
            className="flex-row items-center justify-between py-3 active:opacity-70"
          >
            <Text className="text-sm text-foreground">Billing & credits</Text>
            <ChevronRight size={16} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      {/* My Apps */}
      <View className="px-6 py-6">
        <Text className="text-sm font-semibold text-foreground mb-4">My apps</Text>

        {isLoadingApps ? (
          <Text className="text-sm text-muted-foreground py-4">Loading...</Text>
        ) : apps.length === 0 ? (
          <View className="py-6">
            <Text className="text-sm text-muted-foreground mb-4">
              You haven't created any apps yet.
            </Text>
            <Button onPress={handleCreateApp} size="sm">
              <Text className="text-primary-foreground font-medium text-sm">Create your first app</Text>
            </Button>
          </View>
        ) : (
          <View>
            {apps.map((app, index) => (
              <Pressable
                key={app._id}
                onPress={() => handleViewApp(app._id)}
                className={`flex-row items-center justify-between py-3 active:opacity-70 ${
                  index < apps.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <View className="flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text className="text-sm font-medium text-foreground">{app.name}</Text>
                    {app.isActive && (
                      <View className="px-1.5 py-0.5 rounded bg-green-100">
                        <Text className="text-xs font-medium text-green-700">Active</Text>
                      </View>
                    )}
                  </View>
                  {app.description && (
                    <Text className="text-sm text-muted-foreground mt-0.5" numberOfLines={1}>
                      {app.description}
                    </Text>
                  )}
                </View>
                <ChevronRight size={16} className="text-muted-foreground ml-4" />
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
