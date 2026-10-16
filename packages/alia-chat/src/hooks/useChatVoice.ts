import { useOxy } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AliaAvatarState } from '../components/AliaAvatar';
import { callThread } from '../lib/call-thread';
import { turnActivityState } from '../lib/turn-state';
import { useAliaRuntime } from '../runtime/config';
import { aliaQueryKeys } from '../runtime/query-keys';
import type { Message } from '../runtime/types';
import { type SoundSources, useVoiceSoundEffects } from './useSoundEffects';
import { type UseVoiceLauncherOptions, useVoiceLauncher } from './useVoiceLauncher';

/** What a host tells the chat about its voice call (see {@link UseVoiceLauncherOptions}). */
export type AliaVoiceOptions = Omit<
  UseVoiceLauncherOptions,
  'apiUrl' | 'conversationId' | 'agentId' | 'accountId' | 'resolveConversation' | 'isFocused'
> & {
  /** The cues played as the call thinks, uses tools, connects and ends. Omitted, the call is silent. */
  sounds?: SoundSources;
};

export interface UseChatVoiceOptions {
  /** The host's say: on by default, `false` for a text-only chat, an object for its callbacks. */
  options: false | AliaVoiceOptions | undefined;
  conversationId: string | undefined;
  agentId: string | undefined;
  /** Whether the screen holding the chat is the one on show. A live call ends when it is not. */
  isFocused: boolean;
  /** Makes the conversation a call lives in when none is open (after the gate). */
  ensureConversation: () => Promise<string | undefined>;
  messages: Message[];
  setMessages: (messages: Message[]) => void;
  /** The conversation's stored messages: a call message shows as stored once it is. */
  storedMessages: readonly Message[] | undefined;
  /** A text turn is in flight. */
  isLoading: boolean;
}

/**
 * The chat's voice call.
 *
 * The launcher owns whether a call is open, the gate before one opens and what it reports back
 * (for the ambient wave, the cues and the transcript); the call itself loads on the first one.
 * The transcript is merged into the thread: the text messages the chat held when the call
 * started, then the call's, so the conversation reads as one. And what Alia is doing — the
 * header's mark — follows the call while one is open and the text turn otherwise.
 */
export function useChatVoice({
  options,
  conversationId,
  agentId,
  isFocused,
  ensureConversation,
  messages,
  setMessages,
  storedMessages,
  isLoading,
}: UseChatVoiceOptions) {
  const runtime = useAliaRuntime();
  const { user } = useOxy();
  const queryClient = useQueryClient();
  const enabled = options !== false;
  const { sounds, ...launcherOptions }: AliaVoiceOptions =
    options === false || options === undefined ? {} : options;
  const { onCallEnded } = launcherOptions;

  const refreshConversation = useCallback(
    (id: string) => {
      void queryClient.invalidateQueries({ queryKey: aliaQueryKeys.conversations.detail(id) });
      void queryClient.invalidateQueries({ queryKey: aliaQueryKeys.conversations.all });
    },
    [queryClient],
  );

  const launcher = useVoiceLauncher({
    apiUrl: runtime.apiUrl,
    conversationId,
    agentId,
    accountId: user?.id ?? null,
    locale: runtime.speech.language,
    voice: runtime.speech.voice,
    resolveConversation: ensureConversation,
    onMessagesSaved: refreshConversation,
    isFocused,
    ...launcherOptions,
    // The call's transcript is in the thread, whatever else the host refreshes.
    onCallEnded: () => {
      if (conversationId !== undefined) refreshConversation(conversationId);
      onCallEnded?.();
    },
  });
  const { isActive, state, start } = launcher;
  const agentState = state?.agentState;

  useVoiceSoundEffects({
    isVoiceActive: isActive,
    agentState: agentState ?? 'idle',
    isConnected: state?.isConnected ?? false,
    sounds: sounds ?? {},
  });

  // The transcript, after the text messages the chat held when the call started.
  const textBeforeCall = useRef<Message[]>([]);
  const voiceMessages = state?.messages;
  useEffect(() => {
    if (!voiceMessages) return;
    setMessages(callThread(textBeforeCall.current, voiceMessages, storedMessages));
  }, [voiceMessages, storedMessages, setMessages]);

  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  const activate = useCallback(() => {
    if (isActive) return;
    textBeforeCall.current = [...latestMessages.current];
    void start();
  }, [isActive, start]);

  // What Alia is doing, which the header's mark shows.
  const markState = useMemo<AliaAvatarState>(() => {
    if (isActive) {
      if (agentState === 'speaking') return 'writing';
      if (agentState === 'thinking') return 'thinking';
      return 'idle';
    }
    return turnActivityState(messages, isLoading);
  }, [messages, isLoading, isActive, agentState]);

  return { enabled, launcher, isActive, state, agentState, activate, markState };
}
