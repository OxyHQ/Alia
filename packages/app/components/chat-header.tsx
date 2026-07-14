import { View, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { Search, MoreHorizontal, Menu, Mic } from "lucide-react-native";
import { GhostIcon } from "@/components/ui/ghost-icon";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/model-selector";
import { CreditsMenu } from "@/components/credits-menu";
import { useNavigation, useRouter } from "expo-router";
import type { DrawerNavigationProp } from "expo-router/drawer";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { toast } from "@/components/sonner";
import { confirm } from "@oxyhq/bloom/alert-dialog";
import { useTranslation } from "@/hooks/useTranslation";
import { useTheme, withAlpha } from "@oxyhq/bloom/theme";

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
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<DrawerNavigationProp<ReactNavigation.RootParamList>>();
  const router = useRouter();
  const handleDrawerToggle = () => {
    navigation.toggleDrawer();
  };

  const handleClearConversation = async () => {
    const ok = await confirm({
      title: t('chatHeader.clearConfirmTitle'),
      description: t('chatHeader.clearConfirmDescription'),
      confirmLabel: t('chatHeader.clear'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (ok) onClear?.();
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
      <View
        className="flex-row items-center justify-between px-4"
        style={{ paddingTop: insets.top, height: 56 + insets.top }}
      >
      <View className="flex-row items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onPress={handleDrawerToggle}
          className="h-9 w-9 rounded-full md:hidden"
        >
          <Menu size={20} className="text-muted-foreground" />
        </Button>
        <ModelSelector
          selectedModel={selectedModel}
          onModelChange={onModelChange}
        />
        {isVoiceActive && (
          <View className="h-6 rounded-full px-2 flex-row items-center gap-1" style={{ backgroundColor: withAlpha(colors.info, 0.15) }}>
            <Mic size={12} color={colors.info} />
            <Text className="text-[11px] font-medium" style={{ color: colors.info }}>Voice</Text>
          </View>
        )}
      </View>

      <View className="flex-row items-center gap-2">
        <CreditsMenu />

        {!isConversation && (
          <Button
            variant="ghost"
            size="icon"
            onPress={onGhostModePress}
            className="h-9 w-9 rounded-full"
          >
            <GhostIcon size={20} filled={ghostModeActive} />
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
  );
}
