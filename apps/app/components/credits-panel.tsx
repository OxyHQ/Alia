import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Sparkles, Calendar, X } from "lucide-react-native";
import { useCredits } from "@/lib/hooks/use-credits";
import { useRouter } from "expo-router";
import { useUIStore } from "@/lib/stores/ui-store";

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
    <View className="flex-1 bg-background border-l border-border">
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

        {/* View Usage Link */}
        <Pressable
          onPress={handleViewUsage}
          className="flex-row items-center gap-1 active:opacity-70 mt-2"
        >
          <Text className="text-sm font-medium text-primary">Ver uso</Text>
          <Text className="text-sm text-primary">›</Text>
        </Pressable>
      </View>
    </View>
  );
}
