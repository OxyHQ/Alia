import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Sparkles, Calendar, HelpCircle } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useCreditsStore } from "@/lib/stores/credits-store";
import { useEffect } from "react";
import { useAuthStore } from "@/lib/stores/auth-store";

interface CreditsMenuProps {
  credits?: number;
  freeCredits?: number;
  dailyRefresh?: number;
  refreshTime?: string;
}

export function CreditsMenu({}: CreditsMenuProps) {
  const { credits, freeCredits, dailyRefresh, fetchCredits } = useCreditsStore();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  // Fetch credits on mount if authenticated
  useEffect(() => {
    if (isAuthenticated) {
      fetchCredits();
    }
  }, [isAuthenticated, fetchCredits]);

  const handleUpgrade = () => {
    // TODO: Implement upgrade flow
    console.log("Upgrade clicked");
  };

  const handleViewUsage = () => {
    // TODO: Navigate to usage page
    console.log("View usage clicked");
  };

  // Hide credits menu if user is not signed in
  if (!isAuthenticated) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable className="flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-background border border-border active:opacity-70">
          <Sparkles size={16} className="text-foreground" />
          <Text className="text-sm font-medium text-foreground">
            {credits.toLocaleString()}
          </Text>
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        {/* Header */}
        <View className="flex-row items-center justify-between p-4 border-b border-border">
          <Text className="text-lg font-semibold text-foreground">Free</Text>
          <Button
            onPress={handleUpgrade}
            className="h-9 px-4 rounded-full"
          >
            <Text className="text-sm font-medium text-primary-foreground">
              Upgrade
            </Text>
          </Button>
        </View>

        {/* Credits Section */}
        <View className="p-4 gap-4">
          {/* Total Credits */}
          <View className="gap-1">
            <View className="flex-row items-center gap-2">
              <Sparkles size={18} className="text-muted-foreground" />
              <Text className="text-base font-medium text-foreground">Credits</Text>
              <Pressable className="ml-auto">
                <HelpCircle size={16} className="text-muted-foreground" />
              </Pressable>
            </View>
            <View className="flex-row items-baseline justify-between">
              <Text className="text-sm text-muted-foreground">Free credits</Text>
              <View className="flex-row items-baseline gap-1">
                <Text className="text-2xl font-bold text-foreground">
                  {credits.toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  {freeCredits.toLocaleString()}
                </Text>
              </View>
            </View>
          </View>

          {/* Daily Refresh */}
          <View className="gap-1">
            <View className="flex-row items-center gap-2">
              <Calendar size={18} className="text-muted-foreground" />
              <Text className="text-base font-medium text-foreground">
                Daily refresh credits
              </Text>
              <Pressable className="ml-auto">
                <HelpCircle size={16} className="text-muted-foreground" />
              </Pressable>
            </View>
            <View className="flex-row items-baseline justify-between">
              <Text className="text-sm text-muted-foreground">
                Refresh to {dailyRefresh} at 00:00 every day
              </Text>
              <Text className="text-2xl font-bold text-foreground">
                {dailyRefresh}
              </Text>
            </View>
          </View>

          {/* View Usage Link */}
          <Pressable
            onPress={handleViewUsage}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Text className="text-sm font-medium text-muted-foreground">
              View usage
            </Text>
            <Text className="text-sm text-muted-foreground">›</Text>
          </Pressable>
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
