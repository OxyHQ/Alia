import { View, useWindowDimensions, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { Search, MoreHorizontal, Menu, Ghost, Mic } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/model-selector";
import { useNavigation, useRouter } from "expo-router";
import { DrawerNavigationProp } from "@react-navigation/drawer";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
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
  isConversation?: boolean;
  isVoiceActive?: boolean;
}

export function ChatHeader({
  title,
  selectedModel,
  onModelChange,
  onGhostModePress,
  ghostModeActive = false,
  onSearchPress,
  onClear,
  isConversation = false,
  isVoiceActive = false,
}: ChatHeaderProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const navigation = useNavigation<DrawerNavigationProp<any>>();
  const router = useRouter();
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
    router.push("/(app)/settings");
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
        {isVoiceActive && (
          <View className="h-6 rounded-full px-2 flex-row items-center gap-1" style={{ backgroundColor: 'rgba(56, 189, 248, 0.15)' }}>
            <Mic size={12} color="#38bdf8" />
            <Text className="text-[11px] font-medium" style={{ color: '#38bdf8' }}>Voice</Text>
          </View>
        )}
      </View>

      <View className="flex-row items-center gap-2">
        {!isConversation && (
          <Button
            variant="ghost"
            size="icon"
            onPress={onGhostModePress}
            className={ghostModeActive ? "h-9 w-9 rounded-full bg-accent" : "h-9 w-9 rounded-full"}
          >
            <Ghost size={20} className={ghostModeActive ? "text-accent-foreground" : "text-muted-foreground"} />
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          onPress={() => {
            if (Platform.OS === 'web') {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
            } else {
              onSearchPress?.();
            }
          }}
          className="h-9 w-9 rounded-full"
        >
          <Search size={20} className="text-muted-foreground" />
        </Button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full"
            >
              <MoreHorizontal size={20} className="text-muted-foreground" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            {isConversation && (
              <>
                <DropdownMenu.Item key="share" onSelect={handleShare}>
                  <DropdownMenu.ItemIcon ios={{ name: "square.and.arrow.up" }} />
                  <DropdownMenu.ItemTitle>{t('chatHeader.shareConversation')}</DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
                <DropdownMenu.Item key="export" onSelect={handleExport}>
                  <DropdownMenu.ItemIcon ios={{ name: "arrow.down.doc" }} />
                  <DropdownMenu.ItemTitle>{t('chatHeader.export')}</DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
              </>
            )}
            <DropdownMenu.Item key="settings" onSelect={handleSettings}>
              <DropdownMenu.ItemIcon ios={{ name: "gearshape" }} />
              <DropdownMenu.ItemTitle>{t('chatHeader.settings')}</DropdownMenu.ItemTitle>
            </DropdownMenu.Item>
            <DropdownMenu.Item key="help" onSelect={handleHelp}>
              <DropdownMenu.ItemIcon ios={{ name: "questionmark.circle" }} />
              <DropdownMenu.ItemTitle>{t('chatHeader.help')}</DropdownMenu.ItemTitle>
            </DropdownMenu.Item>
            {isConversation && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Item key="clear" destructive onSelect={handleClearConversation}>
                  <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
                  <DropdownMenu.ItemTitle>{t('chatHeader.clearConversation')}</DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
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
