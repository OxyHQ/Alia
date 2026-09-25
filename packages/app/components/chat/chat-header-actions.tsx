import { useTranslation } from '@/lib/hooks/use-translation';
import { useUIStore } from '@/lib/stores/ui-store';
import { workspacePanelKind } from '@/lib/workspace-panel-kind';
import { Button } from '@oxy.so/bloom/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiDownloadLine } from '@oxy.so/bloom/icons/RiDownloadLine';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiSideBarLine } from '@oxy.so/bloom/icons/RiSideBarLine';
import { RiDashboardLine } from '@oxy.so/bloom/icons/RiDashboardLine';
import { RiDeleteBin6Line } from '@oxy.so/bloom/icons/RiDeleteBin6Line';
import { RiTerminalBoxLine } from '@oxy.so/bloom/icons/RiTerminalBoxLine';
import { confirm } from '@oxy.so/bloom/surfaces';
import React, { useRef } from 'react';

export interface ChatHeaderActionsProps {
  /** Search what was said in this thread. Absent where there is no thread. */
  onSearch?: () => void;
  /** Export the conversation as a Markdown document. */
  onExport: () => void;
  /** Delete the conversation (the caller confirms). Absent where it cannot be. */
  onDelete?: () => void;
  /**
   * Empty the thread, on the server and on screen. Confirmed HERE, because
   * the dialog's promise ("cannot be undone") is this menu's; awaited, so a
   * second press while the first clear is in flight sends nothing.
   */
  onClear?: () => Promise<unknown>;
  /** Show the agent's terminal in the panel. Absent where no agent works in this chat. */
  onOpenTerminal?: () => void;
}

/**
 * The chat's own actions, in the container's breadcrumb row: Bloom's
 * `DropdownMenu` behind the row's "more" glyph.
 *
 * There is deliberately no share item: Alia has no share backend — no public
 * link, no `/conversations/:id/share` — and a share button that could only copy
 * text would be a stub dressed as an action. Bloom's `AgentChatActions` always
 * draws one, which is why this is a menu of Alia's real actions instead.
 *
 * It also shows and hides the right panel, which otherwise opens only when the
 * agent starts working. Shown from here, it is the workspace: the files Alia
 * wrote in this chat, or the gallery when the newest is an image.
 *
 * Memoised with stable callbacks: the screen that owns it re-renders on every
 * streamed token.
 */
export const ChatHeaderActions = React.memo(function ChatHeaderActions({
  onSearch,
  onExport,
  onDelete,
  onClear,
  onOpenTerminal,
}: ChatHeaderActionsProps) {
  const { t } = useTranslation();
  /** Held while a clear is in flight, so the item cannot start a second one. */
  const clearing = useRef(false);
  const handleClear = async () => {
    if (onClear === undefined || clearing.current) return;
    clearing.current = true;
    try {
      const ok = await confirm({
        title: t('chatHeader.clearConfirmTitle'),
        description: t('chatHeader.clearConfirmDescription'),
        confirmLabel: t('chatHeader.clear'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      // Cancelling changes nothing: no request, no local reset. A refusal is
      // reported by the owner of the thread.
      if (ok) await onClear();
    } finally {
      clearing.current = false;
    }
  };
  const panelOpen = useUIStore((s) => s.rightPanel !== null);
  const togglePanel = () => {
    const { setRightPanel, canvasArtifacts } = useUIStore.getState();
    if (panelOpen) setRightPanel(null);
    else setRightPanel(workspacePanelKind(null, canvasArtifacts) === 'gallery' ? 'gallery' : 'canvas');
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={t('chatHeader.moreOptions')}>
        <Button
          size="xs"
          appearance="plain"
          tone="neutral"
          iconOnly
          leadingIcon={RiMoreFill}
          accessibilityLabel={t('chatHeader.moreOptions')}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onSearch === undefined ? null : (
          <DropdownMenuItem onPress={onSearch} leading={<RiSearchLine size="sm" />}>
            {t('chatHeader.searchThread')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onPress={togglePanel} leading={<RiSideBarLine size="sm" />}>
          {panelOpen ? t('chatHeader.hidePanel') : t('chatHeader.showPanel')}
        </DropdownMenuItem>
        {onOpenTerminal === undefined ? null : (
          <DropdownMenuItem onPress={onOpenTerminal} leading={<RiTerminalBoxLine size="sm" />}>
            {t('chatHeader.agentTerminal')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onPress={() => useUIStore.getState().setRightPanel('credits')}
          leading={<RiDashboardLine size="sm" />}
        >
          {t('chatHeader.usage')}
        </DropdownMenuItem>
        <DropdownMenuItem onPress={onExport} leading={<RiDownloadLine size="sm" />}>
          {t('chat.exportMarkdown')}
        </DropdownMenuItem>
        {onClear === undefined && onDelete === undefined ? null : <DropdownMenuSeparator />}
        {onClear === undefined ? null : (
          <DropdownMenuItem
            tone="danger"
            onPress={() => void handleClear()}
            leading={<RiDeleteBin6Line size="sm" />}
          >
            {t('chatHeader.clearConversation')}
          </DropdownMenuItem>
        )}
        {onDelete === undefined ? null : (
          <>
            <DropdownMenuItem
              tone="danger"
              onPress={onDelete}
              leading={<RiDeleteBinLine size="sm" />}
            >
              {t('chat.deleteConversation')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
