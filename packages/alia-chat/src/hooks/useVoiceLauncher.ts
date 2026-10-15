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
  /** The conversation the call's transcript is stored in; omitted, each call starts its own. */
  conversationId?: string;
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
  /**
   * For a screen whose call lives on another one (the new-chat screen has no conversation to
   * hold it): after the gate, hand over instead of opening a call here.
   */
  openElsewhere?: () => void;
  /** Where the call's notices go; omitted, Bloom's toast. */
  onNotice?: (notice: VoiceNotice) => void;
  /** A call is over, however it ended: refresh credits, the thread… */
  onCallEnded?: () => void;
  /**
   * Whose call it would be (the account and the conversation, as one key). A live call ends
   * when it changes.
   */
  owner?: string;
  /** Whether the screen holding the call is the one on show. A live call ends when it is not. */
  isFocused?: boolean;
}

export interface VoiceLauncher {
  /** A call is open (or being opened). */
  isActive: boolean;
  /** What the call reports back; `null` until it is under way. */
  state: VoiceSessionState | null;
  /** Open a call, after the gate. Does nothing while one is open or the screen is not on show. */
  start: () => void;
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
    agentId,
    locale,
    voice,
    onMessagesSaved,
    canStartVoice,
    onVoiceBlocked,
    onNotice,
    onCallEnded,
    openElsewhere,
    owner,
    isFocused = true,
  } = options;
  const [isActive, setIsActive] = useState(false);
  const [state, setState] = useState<VoiceSessionState | null>(null);
  const callOwnerRef = useRef<string | undefined>(undefined);
  const latest = useRef({
    canStartVoice,
    onVoiceBlocked,
    onNotice,
    onCallEnded,
    openElsewhere,
    labels,
  });
  latest.current = { canStartVoice, onVoiceBlocked, onNotice, onCallEnded, openElsewhere, labels };

  const notify = useCallback((notice: VoiceNotice) => {
    (latest.current.onNotice ?? toastNotice)(notice);
  }, []);

  const end = useCallback(() => {
    setIsActive(false);
    setState(null);
    callOwnerRef.current = undefined;
    latest.current.onCallEnded?.();
  }, []);

  const start = useCallback(() => {
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
    if (latest.current.openElsewhere) {
      latest.current.openElsewhere();
      return;
    }
    callOwnerRef.current = owner;
    setIsActive(true);
  }, [isActive, isFocused, owner, notify]);

  // A call belongs to one conversation of one account, on the screen that shows it.
  useEffect(() => {
    if (isActive && (!isFocused || owner !== callOwnerRef.current)) end();
  }, [isActive, isFocused, owner, end]);

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
