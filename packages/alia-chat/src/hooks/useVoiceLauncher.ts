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
import type { VoiceNotice, VoiceSessionProps, VoiceSessionState } from '../types';

export interface UseVoiceLauncherOptions {
  /** Alia API base URL. */
  apiUrl?: string;
  /** The conversation the call lives in, when one is open. */
  conversationId?: string;
  /**
   * Called after the gate, when no conversation is open: creates (and shows) the one the call
   * will live in and returns its id, or `undefined` when it could not be made (the call then
   * does not open). Every call has a conversation, so its transcript has a home.
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
  /** The conversation the live call was opened in; it stays the call's even if the screen moves. */
  const [callConversationId, setCallConversationId] = useState<string | undefined>(undefined);
  /** The account the live call was opened for. */
  const callAccountRef = useRef<string | null | undefined>(undefined);
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
    setCallConversationId(undefined);
    callAccountRef.current = undefined;
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
    if (home === undefined && latest.current.resolveConversation) return;
    callAccountRef.current = accountId;
    setCallConversationId(home);
    setIsActive(true);
  }, [isActive, isFocused, conversationId, accountId, notify]);

  // A call belongs to one account, on the screen that shows it, in the conversation it opened in:
  // it ends when the screen goes out of focus, the account changes, or the screen moves to another
  // conversation. (The conversation a call creates for itself is the one the screen then shows.)
  const shownRef = useRef(conversationId);
  useEffect(() => {
    const moved = shownRef.current !== conversationId;
    shownRef.current = conversationId;
    if (isActive && (!isFocused || callAccountRef.current !== accountId)) end();
    else if (isActive && moved && conversationId !== callConversationId) end();
  }, [isActive, isFocused, accountId, conversationId, callConversationId, end]);

  const sessionProps = useMemo<VoiceSessionProps>(
    () => ({
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(callConversationId === undefined ? {} : { conversationId: callConversationId }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(locale === undefined ? {} : { locale }),
      ...(voice === undefined ? {} : { voice }),
      ...(onMessagesSaved === undefined ? {} : { onMessagesSaved }),
      onNotice: notify,
      onStateChange: setState,
      onEnd: end,
    }),
    [apiUrl, callConversationId, agentId, locale, voice, onMessagesSaved, notify, end],
  );

  return { isActive, state, start, end, sessionProps };
}
