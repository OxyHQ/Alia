import React from "react";
import { View, Platform } from "react-native";
import { Search, MoreHorizontal, Menu } from "lucide-react-native";
import { GhostIcon } from "@/components/ui/ghost-icon";
import { AgentGlyph } from "@/components/ui/agent-glyph";
import { Text } from "@/components/ui/text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { CreditsMenu } from "@/components/credits-menu";
import { useNavigation, useRouter } from "expo-router";
import type { DrawerNavigationProp } from "expo-router/drawer";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { toast } from "@oxyhq/bloom/toast";
import { confirm } from "@oxyhq/bloom/surfaces";
import { useTranslation } from "@/lib/hooks/use-translation";

interface ChatHeaderProps {
  onGhostModePress?: () => void;
  ghostModeActive?: boolean;
  onSearchPress?: () => void;
  onClear?: () => void;
  isConversation?: boolean;
  /**
   * The agent this thread belongs to. Omitted on Alia's own chat, where the
   * header stays exactly as it was — no title, no mark.
   *
   * TWO PRIMITIVES rather than one object, and that is the whole point of the
   * shape: this component is memoized because the chat screen re-renders ~20×/s
   * while streaming, and an identity object built at the call site would be a
   * new reference on every one of those renders, handing all twenty back to the
   * whole header. Strings compare by value, so they cost nothing.
   */
  agentName?: string;
  agentColor?: string | null;
}

// Memoized: the chat screen re-renders ~20×/s while streaming and none of
// these props change per token.
export const ChatHeader = React.memo(function ChatHeader({
  onGhostModePress,
  ghostModeActive = false,
  onSearchPress,
  onClear,
  isConversation = false,
  agentName,
  agentColor,
}: ChatHeaderProps) {
  const { t } = useTranslation();
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
      </View>

      {/* Who this thread is with, iMessage-style. Absent on Alia's own chat,
          where the two flanking groups sit exactly where they always did. */}
      {agentName === undefined ? null : (
        <View className="flex-1 flex-row items-center justify-center gap-2 px-2">
          <AgentGlyph size={24} color={agentColor} label={agentName} />
          <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
            {agentName}
          </Text>
        </View>
      )}

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
});
