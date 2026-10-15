import { useCallback, useEffect, useRef } from 'react';
import { rememberOpener } from '../lib/focus-return';
import { useAliaRuntime } from '../runtime/config';
import { type ThoughtScope, type ThoughtTab, useThoughtStore } from '../runtime/thought-store';
import type { ThreadMessage } from '../runtime/thread/thread-history';

/** Open the thought panel on a turn; `opener` is the control pressed, to give focus back to. */
export type OpenThought = (messageId: string, tab?: ThoughtTab, opener?: unknown) => void;

/**
 * The scope a press on a row hands the thought panel: the conversation the row belongs to, which
 * is not always the one being streamed into.
 *
 * A live row belongs to the conversation on screen. A history row belongs to an earlier stretch
 * of the thread — persisted and complete — so its scope is that stretch's messages and nothing
 * about the live turn. Keyed by conversation and message: the panel never shows one
 * conversation's turn under another's.
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
    messages: history.filter((m) => m.conversationId === past.conversationId),
    status: 'ready',
    isLoading: false,
    failedTurn: null,
  };
}

/**
 * Open the thought panel on any turn — the one in flight or one long past — or `undefined` when
 * the host has no panel to show it in (`AliaRuntimeHost.showThought`): the row then draws its
 * "worked for" line as plain text.
 *
 * `runningTurnId` is the turn in flight once it has begun using tools. The first tool of a turn
 * opens the panel on it unless the host declines (something else is open), once per turn: a
 * reader who closes it keeps it closed.
 *
 * The returned function is stable: it is a prop of every memoised row, while the live scope
 * changes per streamed token, so the scopes are read at press time through a ref.
 */
export function useOpenThought(
  live: ThoughtScope,
  history: readonly ThreadMessage[],
  runningTurnId: string | null,
): OpenThought | undefined {
  const { showThought } = useAliaRuntime().host;
  const select = useThoughtStore((s) => s.open);
  const latest = useRef({ live, history, showThought });
  useEffect(() => {
    latest.current = { live, history, showThought };
  });

  const open = useCallback<OpenThought>(
    (messageId, tab, opener) => {
      const { live: scope, history: past, showThought: show } = latest.current;
      rememberOpener(opener);
      select(messageId, thoughtScopeFor(messageId, scope, past), tab);
      show?.('pressed');
    },
    [select],
  );

  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (runningTurnId === null || autoOpened.current === runningTurnId) return;
    autoOpened.current = runningTurnId;
    const { live: scope, showThought: show } = latest.current;
    if (show?.('automatic') === true) select(runningTurnId, scope);
  }, [runningTurnId, select]);

  return showThought === undefined ? undefined : open;
}
