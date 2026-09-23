import { useAliaSettings } from '@/components/settings/settings-context';
import { SearchIcon } from '@/components/ui/icons/search-icon';
import { useCredits } from '@/lib/hooks/use-credits';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useUIStore } from '@/lib/stores/ui-store';
import { useColorScheme } from '@/lib/useColorScheme';
import { Button } from '@oxy.so/bloom/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import {
  RiDeleteBinLine,
  RiDownloadLine,
  RiMoreFill,
  RiSettings3Line,
} from '@oxy.so/bloom/icons';
import { confirm } from '@oxy.so/bloom/surfaces';
import { useAuth } from '@oxy.so/services';
import React, { useRef } from 'react';
import { Platform } from 'react-native';

interface ChatHeaderProps {
  onGhostModePress?: () => void;
  ghostModeActive?: boolean;
  onSearchPress?: () => void;
  /**
   * Empty the thread. Awaited when it returns a promise: the clear is a server
   * round-trip now (#553), and a second tap on the menu item while the first is
   * still in flight would confirm and send the same request twice.
   */
  onClear?: () => void | Promise<unknown>;
  /**
   * Export this conversation as Markdown. A CALLBACK rather than the messages
   * themselves: the
   * screen that owns the messages re-renders per streamed token, and a prop
   * that changed with them would hand every one of those renders to the whole
   * header. The screen keeps its messages in a ref and gives this one stable
   * function. "Export" is in the menu only when it is provided.
   */
  onExport?: () => void;
  isConversation?: boolean;
}

// Memoized: the chat screen re-renders ~20×/s while streaming and none of
// these props change per token.
export const ChatHeader = React.memo(function ChatHeader({
  onGhostModePress,
  ghostModeActive = false,
  onSearchPress,
  onClear,
  onExport,
  isConversation = false,
}: ChatHeaderProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const { isAuthenticated } = useAuth();
  const { data: credits } = useCredits();
  const toggleRightPanel = useUIStore((state) => state.toggleRightPanel);
  const settings = useAliaSettings();
  /**
   * Held while a clear is in flight, so the menu item cannot start a second
   * one. A ref rather than state because nothing here re-renders on it: the
   * dialog resolves before the request starts and has no in-flight state to
   * show, so the guard is the whole feedback until the thread empties.
   */
  const clearing = useRef(false);

  const handleClearConversation = async () => {
    if (clearing.current) return;
    const ok = await confirm({
      title: t('chatHeader.clearConfirmTitle'),
      description: t('chatHeader.clearConfirmDescription'),
      confirmLabel: t('chatHeader.clear'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    // Cancelling changes nothing: no request, no local reset.
    if (!ok || onClear === undefined) return;
    clearing.current = true;
    try {
      // A refusal is surfaced by the owner of the thread; nothing to add here.
      await onClear();
    } finally {
      clearing.current = false;
    }
  };

  const handleSettings = () => {
    settings.open();
  };

  /*
   * Two items are deliberately NOT in the menu.
   *
   * "Share conversation": there is no share backend — no public links, no
   * `/conversations/:id/share` — so the item could only ever say "coming soon"
   * AFTER being chosen, which is a stub dressed as an action. It comes back
   * when there is something for it to do.
   *
   * "Help": there is no docs URL anywhere in `lib/config.ts` or the constants
   * to open, so the same applies. Add the URL there first, then the item with
   * `Linking.openURL`.
   */

  return (
    <DropdownMenu>
      <DropdownMenuTrigger label="Actions" asChild>
        <Button
          appearance="plain"
          tone="neutral"
          size="xs"
          accessibilityRole="button"
          accessibilityLabel={t('chatHeader.moreOptions')}

          icon={<RiMoreFill size="sm" fill={colors.mutedForeground} />}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!isConversation && onGhostModePress && (
          <DropdownMenuCheckboxItem
            checked={ghostModeActive}
            onCheckedChange={onGhostModePress}
          >
            {t('chatHeader.temporaryChat')}
          </DropdownMenuCheckboxItem>
        )}
        <DropdownMenuItem
          onPress={() => {
            if (onSearchPress) onSearchPress();
            else if (Platform.OS === 'web')
              document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'k', metaKey: true }),
              );
          }}
          leading={<SearchIcon size={18} color={colors.mutedForeground} />}
        >
          {onSearchPress
            ? t('chatHeader.searchThread')
            : t('chatHeader.searchConversations')}
        </DropdownMenuItem>
        {isAuthenticated && (
          <DropdownMenuItem onPress={() => toggleRightPanel('credits')}>
            {'Credits'} · {(credits?.credits ?? 0).toLocaleString()}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {isConversation && onExport !== undefined && (
          <>
            <DropdownMenuItem
              key="export"
              onPress={onExport}
              leading={<RiDownloadLine size="sm" />}
            >
              {t('chatHeader.export')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          key="settings"
          onPress={handleSettings}
          leading={<RiSettings3Line size="sm" />}
        >
          {t('chatHeader.settings')}
        </DropdownMenuItem>
        {isConversation && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              key="clear"
              tone="danger"
              onPress={handleClearConversation}
              leading={<RiDeleteBinLine size="sm" />}
            >
              {t('chatHeader.clearConversation')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
