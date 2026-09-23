import { useTranslation } from '@/lib/hooks/use-translation';
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
import React from 'react';

export interface ChatHeaderActionsProps {
  /** Search what was said in this thread. Absent where there is no thread. */
  onSearch?: () => void;
  /** Export the conversation as a Markdown document. */
  onExport: () => void;
  /** Delete the conversation (the caller confirms). Absent where it cannot be. */
  onDelete?: () => void;
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
 * Memoised with stable callbacks: the screen that owns it re-renders on every
 * streamed token.
 */
export const ChatHeaderActions = React.memo(function ChatHeaderActions({
  onSearch,
  onExport,
  onDelete,
}: ChatHeaderActionsProps) {
  const { t } = useTranslation();
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
        <DropdownMenuItem onPress={onExport} leading={<RiDownloadLine size="sm" />}>
          {t('chat.exportMarkdown')}
        </DropdownMenuItem>
        {onDelete === undefined ? null : (
          <>
            <DropdownMenuSeparator />
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
