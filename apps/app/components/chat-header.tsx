import { View, useWindowDimensions } from "react-native";
import { Text } from "@/components/ui/text";
import { Crown, Search, MoreHorizontal, Menu } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/model-selector";
import { useNavigation } from "expo-router";
import { DrawerNavigationProp } from "@react-navigation/drawer";

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
  const dimensions = useWindowDimensions();
  const navigation = useNavigation<DrawerNavigationProp<any>>();
  const isLargeScreen = dimensions.width >= 768;

  const handleDrawerToggle = () => {
    navigation.toggleDrawer();
  };

  return (
    <View
      className="flex-row items-center justify-between px-4"
      style={{ paddingTop: insets.top, height: 56 + insets.top }}
    >
      <View className="flex-row items-center gap-2">
        {!isLargeScreen && (
          <Button
            variant="ghost"
            size="icon"
            onPress={handleDrawerToggle}
            className="h-9 w-9 rounded-lg"
          >
            <Menu size={20} className="text-muted-foreground" />
          </Button>
        )}
        <ModelSelector
          selectedModel={selectedModel}
          onModelChange={onModelChange}
        />
      </View>

      <View className="flex-row items-center gap-2">

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
