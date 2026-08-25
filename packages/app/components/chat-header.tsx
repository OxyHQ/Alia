import React from "react";
import { View, Platform } from "react-native";
import { GhostIcon } from "@/components/ui/ghost-icon";
import { DotsHorizontalIcon } from "@/components/ui/icons/dots-horizontal-icon";
import { MenuIcon } from "@/components/ui/icons/menu-icon";
import { SearchIcon } from "@/components/ui/icons/search-icon";
import { IdentityMark } from "@alia.onl/sdk";
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
import { agentTint } from "@/lib/agents/agent-color";
import { useColorScheme } from "@/lib/useColorScheme";

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
  const { colors } = useColorScheme();
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

  /*
   * Three columns, so the title sits in the middle of the HEADER rather than in
   * the middle of whatever the two flanking groups leave over. Equal side
   * columns are the whole mechanism: the centre is centred in the header if and
   * only if left and right are the same width.
   *
   * `md:flex-1` and not `flex-1`, because below that breakpoint the two cannot
   * both be had. Measured on a 375px screen: the controls on the right need
   * 167px of the 343px available, and mirroring that on the left to centre the
   * title would leave it 9px. A third is 109px, so equal thirds there puts the
   * credits pill 58px on top of the name. Below `md` the columns therefore keep
   * their natural widths — which already centres the title in the band between
   * them, measured dead-on — and the header stays exactly as it was. Narrowing
   * the right-hand controls is what would make a centred title possible there.
   *
   * `justify-between` still matters for the case with no agent and no centre
   * column: it is what holds the two groups apart below `md`, and a no-op above
   * it, where the two thirds already fill the row.
   */
  return (
      <View
        className="flex-row items-center justify-between px-4"
        style={{ paddingTop: insets.top, height: 56 + insets.top }}
      >
      <View className="flex-row items-center justify-start gap-2 md:flex-1">
        <Button
          variant="ghost"
          size="icon"
          onPress={handleDrawerToggle}
          className="h-9 w-9 rounded-full md:hidden"
        >
          <MenuIcon size={20} color={colors.mutedForeground} />
        </Button>
      </View>

      {/* Who this thread is with, iMessage-style. Absent on Alia's own chat,
          where the two flanking groups sit exactly where they always did.

          `shrink` on the name is what makes a long one TRUNCATE instead of
          push: React Native defaults `flexShrink` to 0, so without it the text
          keeps its full width and runs under the controls on the right —
          measured at 8px of overlap on a 375px screen, against 8px of clearance
          with it. `numberOfLines` only clips what the box already bounds. */}
      {agentName === undefined ? null : (
        <View className="flex-1 flex-row items-center justify-center gap-2 px-2">
          <IdentityMark size={24} color={agentTint(agentColor, colors)} accessibilityLabel={agentName} />
          <Text className="shrink text-base font-semibold text-foreground" numberOfLines={1}>
            {agentName}
          </Text>
        </View>
      )}

      <View className="flex-row items-center justify-end gap-2 md:flex-1">
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
          /**
           * A handler wins over the palette, on BOTH platforms.
           *
           * A thread passes one and means "search what was said here", which is
           * not the question ⌘K answers — that one finds a chat. Everywhere
           * else nothing is passed and the palette opens exactly as before.
           *
           * This prop had been declared and never given: web never consulted
           * it, and no screen passed one, so the native branch was unreachable
           * too.
           */
          onPress={() => {
            if (onSearchPress !== undefined) {
              onSearchPress();
            } else if (Platform.OS === 'web') {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
            }
          }}
          className="h-9 w-9 rounded-full"
        >
          <SearchIcon size={20} color={colors.mutedForeground} />
        </Button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full"
            >
              <DotsHorizontalIcon size={20} color={colors.mutedForeground} />
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
