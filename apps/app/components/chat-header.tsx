import { View, useWindowDimensions } from "react-native";
import { Text } from "@/components/ui/text";
import { Search, MoreHorizontal, Menu, Ghost, Trash2, Download, Share2, Settings, HelpCircle } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/model-selector";
import { CreditsMenu } from "@/components/credits-menu";
import { useNavigation } from "expo-router";
import { DrawerNavigationProp } from "@react-navigation/drawer";
import { Dropdown, MenuItem, Separator } from "@/components/ui/dropdown";
import { toast } from "@/components/sonner";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";

interface ChatHeaderProps {
  title: string;
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  onGhostModePress?: () => void;
  ghostModeActive?: boolean;
  onSearchPress?: () => void;
  onClear?: () => void;
}

export function ChatHeader({
  title,
  selectedModel,
  onModelChange,
  onGhostModePress,
  ghostModeActive = false,
  onSearchPress,
  onClear,
}: ChatHeaderProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const navigation = useNavigation<DrawerNavigationProp<any>>();
  const isLargeScreen = dimensions.width >= 768;
  const [showClearDialog, setShowClearDialog] = useState(false);

  const handleDrawerToggle = () => {
    navigation.toggleDrawer();
  };

  const handleClearConversation = () => {
    setShowClearDialog(true);
  };

  const confirmClearConversation = () => {
    onClear?.();
  };

  const handleExport = () => {
    toast.info(t('chatHeader.exportComingSoon'));
  };

  const handleShare = () => {
    toast.info(t('chatHeader.shareComingSoon'));
  };

  const handleSettings = () => {
    toast.info(t('chatHeader.settingsComingSoon'));
  };

  const handleHelp = () => {
    toast.info(t('chatHeader.helpComingSoon'));
  };

  return (
    <>
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
            <Text className="text-sm">{t('chatHeader.shareConversation')}</Text>
          </MenuItem>
          <MenuItem onPress={handleExport}>
            <Download size={14} className="text-muted-foreground" />
            <Text className="text-sm">{t('chatHeader.export')}</Text>
          </MenuItem>
          <Separator />
          <MenuItem onPress={handleSettings}>
            <Settings size={14} className="text-muted-foreground" />
            <Text className="text-sm">{t('chatHeader.settings')}</Text>
          </MenuItem>
          <MenuItem onPress={handleHelp}>
            <HelpCircle size={14} className="text-muted-foreground" />
            <Text className="text-sm">{t('chatHeader.help')}</Text>
          </MenuItem>
          <Separator />
          <MenuItem onPress={handleClearConversation} variant="destructive">
            <Trash2 size={14} className="text-destructive" />
            <Text className="text-sm text-destructive">{t('chatHeader.clearConversation')}</Text>
          </MenuItem>
        </Dropdown>
      </View>
    </View>

      {/* Clear Conversation Confirmation Dialog */}
      <ConfirmationDialog
        open={showClearDialog}
        onOpenChange={setShowClearDialog}
        title={t('chatHeader.clearConfirmTitle')}
        description={t('chatHeader.clearConfirmDescription')}
        confirmText={t('chatHeader.clear')}
        cancelText={t('common.cancel')}
        confirmVariant="destructive"
        onConfirm={confirmClearConversation}
      />
    </>
  );
}
