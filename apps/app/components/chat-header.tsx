import { View, useWindowDimensions, Alert } from "react-native";
import { Text } from "@/components/ui/text";
import { Crown, Search, MoreHorizontal, Menu, Ghost, Trash2, Download, Share2, Settings, HelpCircle } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/model-selector";
import { CreditsMenu } from "@/components/credits-menu";
import { useNavigation } from "expo-router";
import { DrawerNavigationProp } from "@react-navigation/drawer";
import { Dropdown, MenuItem, Separator } from "@/components/ui/dropdown";

interface ChatHeaderProps {
  title: string;
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  onHostModePress?: () => void;
  onGhostModePress?: () => void;
  ghostModeActive?: boolean;
  onSearchPress?: () => void;
}

export function ChatHeader({
  title,
  selectedModel,
  onModelChange,
  onHostModePress,
  onGhostModePress,
  ghostModeActive = false,
  onSearchPress,
}: ChatHeaderProps) {
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const navigation = useNavigation<DrawerNavigationProp<any>>();
  const isLargeScreen = dimensions.width >= 768;

  const handleDrawerToggle = () => {
    navigation.toggleDrawer();
  };

  const handleClearConversation = () => {
    Alert.alert(
      'Clear conversation',
      'Are you sure you want to clear this conversation? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => console.log('Clear conversation') }
      ]
    );
  };

  const handleExport = () => {
    Alert.alert('Export', 'Export conversation functionality coming soon!');
  };

  const handleShare = () => {
    Alert.alert('Share', 'Share conversation functionality coming soon!');
  };

  const handleSettings = () => {
    Alert.alert('Settings', 'Settings functionality coming soon!');
  };

  const handleHelp = () => {
    Alert.alert('Help', 'Help functionality coming soon!');
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
            className="h-9 w-9 rounded-full"
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
        <CreditsMenu />

        <Button
          variant="ghost"
          size="icon"
          onPress={onGhostModePress}
          className={ghostModeActive ? "h-9 w-9 rounded-full bg-accent" : "h-9 w-9 rounded-full"}
        >
          <Ghost size={20} className={ghostModeActive ? "text-accent-foreground" : "text-muted-foreground"} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onPress={onHostModePress}
          className="h-9 w-9 rounded-full"
        >
          <Crown size={20} className="text-muted-foreground" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onPress={onSearchPress}
          className="h-9 w-9 rounded-full"
        >
          <Search size={20} className="text-muted-foreground" />
        </Button>

        <Dropdown
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full"
            >
              <MoreHorizontal size={20} className="text-muted-foreground" />
            </Button>
          }
          align="end"
        >
          <MenuItem onPress={handleShare}>
            <Share2 size={14} className="text-muted-foreground" />
            <Text className="text-sm">Share conversation</Text>
          </MenuItem>
          <MenuItem onPress={handleExport}>
            <Download size={14} className="text-muted-foreground" />
            <Text className="text-sm">Export</Text>
          </MenuItem>
          <Separator />
          <MenuItem onPress={handleSettings}>
            <Settings size={14} className="text-muted-foreground" />
            <Text className="text-sm">Settings</Text>
          </MenuItem>
          <MenuItem onPress={handleHelp}>
            <HelpCircle size={14} className="text-muted-foreground" />
            <Text className="text-sm">Help</Text>
          </MenuItem>
          <Separator />
          <MenuItem onPress={handleClearConversation} variant="destructive">
            <Trash2 size={14} className="text-destructive" />
            <Text className="text-sm text-destructive">Clear conversation</Text>
          </MenuItem>
        </Dropdown>
      </View>
    </View>
  );
}
