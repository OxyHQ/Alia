import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { Crown, Search, MoreHorizontal } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/model-selector";

interface ChatHeaderProps {
  title: string;
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  onHostModePress?: () => void;
  onSearchPress?: () => void;
  onMorePress?: () => void;
}

export function ChatHeader({
  title,
  selectedModel,
  onModelChange,
  onHostModePress,
  onSearchPress,
  onMorePress,
}: ChatHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center justify-between px-4"
      style={{ paddingTop: insets.top, height: 56 + insets.top }}
    >
      <Text className="text-lg font-semibold text-foreground">{title}</Text>

      <View className="flex-row items-center gap-2">
        <ModelSelector
          selectedModel={selectedModel}
          onModelChange={onModelChange}
        />

        <Button
          variant="ghost"
          size="icon"
          onPress={onHostModePress}
          className="h-9 w-9 rounded-lg"
        >
          <Crown size={20} className="text-muted-foreground" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onPress={onSearchPress}
          className="h-9 w-9 rounded-lg"
        >
          <Search size={20} className="text-muted-foreground" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onPress={onMorePress}
          className="h-9 w-9 rounded-lg"
        >
          <MoreHorizontal size={20} className="text-muted-foreground" />
        </Button>
      </View>
    </View>
  );
}
