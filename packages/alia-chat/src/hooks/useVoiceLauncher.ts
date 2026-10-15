/**
 * The host side of a voice call, shared by every surface that offers one.
 *
 * It owns whether a call is open, the state it reports back (for the ambient
 * wave, the sound effects and the transcript), the gate before one opens (plan,
 * credits, sign-in: the host answers, the SDK tells the person), and the end of
 * a call that is no longer the screen's — another screen on show, another
 * conversation, another account. `sessionProps` is everything `VoiceSession`
 * needs; the sheet, `AliaChatScreen` and the Alia app all spread it.
 *
 * Nothing here imports the call or its audio engine.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import { useLabels, type VoiceBlockReason } from '../lib/labels';
import { isRequestFor, useVoiceCallRequests } from '../lib/voice-call-request';
import type { VoiceNotice, VoiceSessionProps, VoiceSessionState } from '../types';

export interface UseVoiceLauncherOptions {
  /** Alia API base URL. */
  apiUrl?: string;
  /** The conversation open on this screen, which is where the call lives. */
  conversationId?: string;
  /**
   * Called after the gate, when no conversation is open: creates (and shows) the one the call
   * will live in and returns its id, or `undefined` when it could not be made (the call then
   * does not open). Every call has a conversation, so its transcript has a home. The call opens
   * on the screen that shows that conversation: this one, or the one the host navigates to.
   */
  resolveConversation?: () => Promise<string | undefined>;
  /** Whose call it would be. A live call ends when the account, or the open conversation, changes. */
  accountId?: string | null;
  /** The agent the call talks to; omitted, Alia. */
  agentId?: string;
  /** Language spoken (BCP-47); omitted, the platform's. */
  locale?: string;
  /** Which of the product's two voices answers. */
  voice?: 'male' | 'female';
  /** Alia stored messages of the call in the conversation: refresh the thread. */
  onMessagesSaved?: VoiceSessionProps['onMessagesSaved'];
  /**
   * The gate before a call opens: why it may not (no account, no plan, no credits), or `null`.
   * The person is told (`labels.voiceBlocked`); `onVoiceBlocked` adds what only the host can do.
   */
  canStartVoice?: () => VoiceBlockReason | null;
  /** The call was not opened for `reason`: sign the person in, open the plans… */
  onVoiceBlocked?: (reason: VoiceBlockReason) => void;
  /** Where the call's notices go; omitted, Bloom's toast. */
  onNotice?: (notice: VoiceNotice) => void;
  /** A call is over, however it ended: refresh credits, the thread… */
  onCallEnded?: () => void;
  /** Whether the screen holding the call is the one on show. A live call ends when it is not. */
  isFocused?: boolean;
}

export interface VoiceLauncher {
  /** A call is open (or being opened). */
  isActive: boolean;
  /** What the call reports back; `null` until it is under way. */
  state: VoiceSessionState | null;
  /** Open a call, after the gate. Does nothing while one is open or the screen is not on show. */
  start: () => Promise<void>;
  /** End the call. */
  end: () => void;
  /** Spread onto `VoiceSession` (or `AliaVoiceCall`). */
  sessionProps: VoiceSessionProps;
}

/** Bloom's toast, by kind: the default home of a call's notices. */
export function toastNotice({ kind, text }: VoiceNotice): void {
  if (kind === 'error') toast.error(text);
  else if (kind === 'warning') toast.warning(text);
  else toast.info(text);
}

export function useVoiceLauncher(options: UseVoiceLauncherOptions = {}): VoiceLauncher {
  const labels = useLabels();
  const {
    apiUrl,
    conversationId,
    resolveConversation,
    accountId = null,
    agentId,
    locale,
    voice,
    onMessagesSaved,
    canStartVoice,
    onVoiceBlocked,
    onNotice,
    onCallEnded,
    isFocused = true,
  } = options;
  const [isActive, setIsActive] = useState(false);
  const [state, setState] = useState<VoiceSessionState | null>(null);
  const latest = useRef({
    canStartVoice,
    onVoiceBlocked,
    onNotice,
    onCallEnded,
    resolveConversation,
    labels,
  });
  latest.current = {
    canStartVoice,
    onVoiceBlocked,
    onNotice,
    onCallEnded,
    resolveConversation,
    labels,
  };

  const notify = useCallback((notice: VoiceNotice) => {
    (latest.current.onNotice ?? toastNotice)(notice);
  }, []);

  const end = useCallback(() => {
    setIsActive(false);
    setState(null);
    latest.current.onCallEnded?.();
  }, []);

  const start = useCallback(async () => {
    if (isActive || !isFocused) return;
    const reason = latest.current.canStartVoice?.() ?? null;
    if (reason !== null) {
      notify({
        kind: reason === 'credits-exhausted' ? 'error' : 'info',
        text: latest.current.labels.voiceBlocked(reason),
      });
      latest.current.onVoiceBlocked?.(reason);
      return;
    }
    // The gate first: a call that may not open must not leave an empty conversation behind.
    const home = conversationId ?? (await latest.current.resolveConversation?.());
    if (home === undefined) return;
    // The call opens where its conversation is shown (see `useVoiceCallRequests`): here, at once,
    // when it already is; wherever the host takes the new conversation, when it was just made.
    useVoiceCallRequests.getState().ask(home, accountId);
  }, [isActive, isFocused, conversationId, accountId, notify]);

  const request = useVoiceCallRequests((store) => store.request);
  useEffect(() => {
    if (isActive || !isFocused || !isRequestFor(request, conversationId, accountId)) return;
    useVoiceCallRequests.getState().clear();
    setIsActive(true);
  }, [request, isActive, isFocused, conversationId, accountId]);

  // A call belongs to one account and one conversation, on the screen that shows it: it ends when
  // the screen goes out of focus, the account changes, or the screen moves to another conversation.
  const openedIn = useRef<{ conversationId: string | undefined; accountId: string | null }>(
    undefined,
  );
  useEffect(() => {
    if (!isActive) {
      openedIn.current = undefined;
      return;
    }
    openedIn.current ??= { conversationId, accountId };
    const call = openedIn.current;
    if (!isFocused || call.accountId !== accountId || call.conversationId !== conversationId) end();
  }, [isActive, isFocused, accountId, conversationId, end]);

  const sessionProps = useMemo<VoiceSessionProps>(
    () => ({
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(locale === undefined ? {} : { locale }),
      ...(voice === undefined ? {} : { voice }),
      ...(onMessagesSaved === undefined ? {} : { onMessagesSaved }),
      onNotice: notify,
      onStateChange: setState,
      onEnd: end,
    }),
    [apiUrl, conversationId, agentId, locale, voice, onMessagesSaved, notify, end],
  );

  return { isActive, state, start, end, sessionProps };
}
