import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Sparkles, Calendar } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCredits } from "@/lib/hooks/use-credits";
import { useOxy } from "@oxyhq/services";
import { useRouter } from "expo-router";

export function CreditsMenu() {
  const router = useRouter();
  const { activeSessionId } = useOxy();
  const { data } = useCredits();

  const credits = data?.credits ?? 0;
  const freeCredits = data?.freeCredits ?? 0;
  const dailyRefresh = data?.dailyRefresh ?? 0;

  const handleUpgrade = () => {
    router.push("/(app)/billing");
  };

  const handleViewUsage = () => {
    router.push("/(app)/billing");
  };

  // Hide credits menu if user is not signed in
  if (!activeSessionId) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable className="flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-background border border-border active:opacity-70">
          <Sparkles size={16} className="text-foreground" />
          <Text className="text-sm font-medium text-foreground">
            {credits.toLocaleString()}
          </Text>
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-0">
        {/* Header */}
        <View className="flex-row items-center justify-between px-3 py-2 border-b border-border">
          <Text className="text-sm font-semibold text-foreground">Free</Text>
          <Button
            onPress={handleUpgrade}
            className="h-7 px-3 rounded-full"
          >
            <Text className="text-xs font-medium text-primary-foreground">
              Upgrade
            </Text>
          </Button>
        </View>

        {/* Credits Section */}
        <View className="p-3 gap-3">
          {/* Total Credits */}
          <View className="gap-0.5">
            <View className="flex-row items-center gap-1.5">
              <Sparkles size={14} className="text-muted-foreground" />
              <Text className="text-xs font-medium text-foreground">Credits</Text>
            </View>
            <View className="flex-row items-baseline justify-between pl-5">
              <Text className="text-xs text-muted-foreground">Free credits</Text>
              <View className="flex-row items-baseline gap-1">
                <Text className="text-xl font-bold text-foreground">
                  {credits.toLocaleString()}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  / {freeCredits.toLocaleString()}
                </Text>
              </View>
            </View>
          </View>

          {/* Daily Refresh */}
          <View className="gap-0.5">
            <View className="flex-row items-center gap-1.5">
              <Calendar size={14} className="text-muted-foreground" />
              <Text className="text-xs font-medium text-foreground">
                Daily refresh
              </Text>
            </View>
            <View className="flex-row items-baseline justify-between pl-5">
              <Text className="text-xs text-muted-foreground">
                at 00:00
              </Text>
              <Text className="text-xl font-bold text-foreground">
                {dailyRefresh}
              </Text>
            </View>
          </View>

          {/* View Usage Link */}
          <Pressable
            onPress={handleViewUsage}
            className="flex-row items-center gap-1 active:opacity-70 pl-0.5"
          >
            <Text className="text-xs font-medium text-muted-foreground">
              View usage
            </Text>
            <Text className="text-xs text-muted-foreground">›</Text>
          </Pressable>
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
