import { rememberOpener } from '@/features/chat/ui/execution/focus-return';
import { useUIStore, type ThoughtScope, type ThoughtTab } from '@/features/chat/runtime/ui-store';
import type { ThreadMessage } from '@/features/chat/model/thread-history';
import type { Message as ConversationMessage } from '@/features/chat/runtime/use-conversations';
import { useCallback, useEffect, useRef } from 'react';

export type OpenThought = (messageId: string, tab?: ThoughtTab, opener?: unknown) => void;

/**
 * The scope a press on a row hands the thought panel: the conversation the row
 * belongs to, which is not always the one being streamed into.
 *
 * A live row belongs to the conversation on screen. A history row belongs to
 * an earlier stretch of the thread — persisted and complete — so its scope is
 * that stretch's messages and nothing about the live turn. Keyed by
 * conversation and message (#608 §5): the panel never shows one conversation's
 * turn under another's.
 */
export function thoughtScopeFor(
  messageId: string,
  live: ThoughtScope,
  history: readonly ThreadMessage[],
): ThoughtScope {
  if (live.messages.some((m) => m.id === messageId)) return live;
  const past = history.find((m) => m.id === messageId);
  if (past === undefined) return live;
  return {
    conversationId: past.conversationId,
    messages: history.filter((m) => m.conversationId === past.conversationId) as unknown as ConversationMessage[],
    status: 'ready',
    isLoading: false,
    failedTurn: null,
  };
}

/**
 * Open the thought panel on any turn — the one in flight or one long past.
 *
 * Stable: it is a prop of every memoised row, while the live scope changes per
 * streamed token, so the scopes are read at press time through a ref.
 */
export function useOpenThought(live: ThoughtScope, history: readonly ThreadMessage[]): OpenThought {
  const openThoughtPanel = useUIStore((s) => s.openThoughtPanel);
  const scopes = useRef({ live, history });
  useEffect(() => {
    scopes.current = { live, history };
  });
  return useCallback<OpenThought>(
    (messageId, tab, opener) => {
      rememberOpener(opener);
      openThoughtPanel(messageId, thoughtScopeFor(messageId, scopes.current.live, scopes.current.history), tab);
    },
    [openThoughtPanel],
  );
}
