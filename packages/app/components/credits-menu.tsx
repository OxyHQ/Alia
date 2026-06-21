import { Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Sparkles } from "lucide-react-native";
import { useCredits } from "@/lib/hooks/use-credits";
import { useOxy } from "@oxyhq/services";
import { useUIStore } from "@/lib/stores/ui-store";

export function CreditsMenu() {
  const { isAuthenticated } = useOxy();
  const { data } = useCredits();
  const toggleRightPanel = useUIStore((state) => state.toggleRightPanel);

  const credits = data?.credits ?? 0;

  // Hide credits menu if user is not signed in
  if (!isAuthenticated) {
    return null;
  }

  return (
    <Pressable
      onPress={() => toggleRightPanel("credits")}
      className="flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-background border border-border active:opacity-70"
    >
      <Sparkles size={16} className="text-foreground" />
      <Text className="text-sm font-medium text-foreground">
        {credits.toLocaleString()}
      </Text>
    </Pressable>
  );
}
