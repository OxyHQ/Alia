/**
 * Voice mode for the open conversation.
 *
 * A call is the conversation, spoken. Each thing the person says is sent with
 * the screen's own `sendMessage` — the same `/alia/chat` turn a typed message
 * is, with the conversation, the agent, the model and every tool it has — and
 * marked `responseMode: 'voice'` so the answer is meant to be heard. So a
 * call's turns land in the thread as ordinary messages, persisted by the server
 * like any other, and nothing has to be merged into or saved from the screen
 * when the call ends. The SDK's `useVoiceRoom` does the listening (on the
 * device) and the speaking (`/v1/audio/speech`, sentence by sentence).
 *
 * A call belongs to one conversation of one account, on the screen that shows
 * it. When the screen stops being the one on show (another route pushed over
 * it, the drawer's next chat), the conversation it speaks to changes, or the
 * account does, the call ENDS: the microphone is released and the controls go
 * with it. It never follows the person to another conversation, where its
 * turns would land in a thread they did not start it in, and it never keeps
 * listening behind a screen that has no controls to stop it.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/api/query-keys';
import { useVoiceRoom } from '@/features/voice/runtime/use-voice-room';
import { useAudioLevelMonitor, useAudioLevels, type VoiceTurnSender } from '@alia.onl/sdk/voice';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from '@/shared/i18n/use-translation';
import { voiceErrorText } from '@/features/voice/model/voice-error-text';
import type { Attachment } from '@/features/chat/runtime/global-store';
import type { SendOptions } from '@/features/chat/runtime/use-streaming-chat';

/**
 * The call ended because the turn could not be sent at all. `sendMessage` has
 * already said so — a toast, or the usage-limit dialog — so voice mode ends the
 * call without saying it a second time.
 */
const TURN_NOT_SENT = 'voice-turn-not-sent';

interface UseVoiceModeOptions {
  /** The conversation's own send — `useChatConversation().sendMessage`. */
  sendMessage: (content: string, attachments?: Attachment[], options?: SendOptions) => Promise<boolean>;
  /** Stops the turn streaming now; how talking over an answer cancels it. */
  stopGeneration: () => void;
  onDeactivate?: () => void;
  /**
   * Whose call it would be: the conversation and the account, as one key
   * (`conversation-screen.tsx` joins the two ids). A call ends when it changes.
   */
  owner: string;
  /** Whether the screen holding the call is the one on show. A call ends when it is not. */
  isFocused: boolean;
}

export function useVoiceMode({ sendMessage, stopGeneration, onDeactivate, owner, isFocused }: UseVoiceModeOptions) {
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  /** The owner the live call was started for; `null` while there is none. */
  const callOwnerRef = useRef<string | null>(null);

  /**
   * Whether this activation ever reached a room.
   *
   * `disconnected` is not only how a call ENDS, it is also where every call
   * STARTS: `activateVoice` flips `isVoiceActive` and asks the room to connect,
   * and until that connect lands the room still reports `disconnected`. So the
   * unexpected-disconnection effect below needs something to tell "we have not
   * connected yet" from "we were connected and lost it".
   *
   * It used to ask `voiceStartIndexRef.current > 0` — the count of text
   * messages on screen when the call began. That is a fact about the
   * TRANSCRIPT, not about the room, and it reads as zero for a call started
   * from an empty chat, which is the ordinary way to start one. Those calls
   * could never auto-deactivate. This asks the room instead.
   */
  const hasConnectedRef = useRef(false);

  // Read at call time: the loop calls these long after the render that built it.
  const sendRef = useRef(sendMessage);
  sendRef.current = sendMessage;
  const stopRef = useRef(stopGeneration);
  stopRef.current = stopGeneration;

  const sendTurn = useCallback<VoiceTurnSender>(async ({ text, signal, onText }) => {
    const cancel = (): void => stopRef.current();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const sent = await sendRef.current(text, undefined, { responseMode: 'voice', onAnswerText: onText });
      if (!sent && !signal.aborted) throw new Error(TURN_NOT_SENT);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }, []);

  const voiceRoom = useVoiceRoom(sendTurn);
  const { captureLevel, playbackLevel } = useAudioLevelMonitor(voiceRoom.room, voiceRoom.isConnected);
  const { waveAmplitude } = useAudioLevels({
    captureLevel,
    playbackLevel,
    agentState: voiceRoom.agentState,
    isConnected: voiceRoom.isConnected,
  });

  // Auto-deactivate on error or connection failure
  useEffect(() => {
    if (!isVoiceActive) return;
    if (voiceRoom.error) {
      if (voiceRoom.error !== TURN_NOT_SENT) {
        toast.error(voiceErrorText(t, voiceRoom.errorCode) ?? t('voice.connectionFailed'));
      }
      deactivateVoice();
    } else if (voiceRoom.roomState === 'error') {
      toast.error(t('voice.connectionFailed'));
      deactivateVoice();
    }
  }, [voiceRoom.error, voiceRoom.errorCode, voiceRoom.roomState, isVoiceActive]);

  // A turn that went wrong without ending the call: say so, keep listening.
  useEffect(() => {
    if (!isVoiceActive) return;
    const text = voiceErrorText(t, voiceRoom.turnErrorCode);
    if (text !== null) toast.error(text);
  }, [voiceRoom.turnErrorCode, isVoiceActive]);

  // The call ends when its screen is no longer on show, or when the
  // conversation or the account it was started for is no longer this one.
  useEffect(() => {
    if (!isVoiceActive) return;
    if (!isFocused || owner !== callOwnerRef.current) deactivateVoice();
  }, [isFocused, owner, isVoiceActive]);

  // Auto-deactivate on unexpected disconnection
  useEffect(() => {
    if (!isVoiceActive) return;
    if (voiceRoom.roomState === 'connected') {
      hasConnectedRef.current = true;
      return;
    }
    if (voiceRoom.roomState === 'disconnected' && hasConnectedRef.current) {
      deactivateVoice();
    }
  }, [voiceRoom.roomState, isVoiceActive]);

  const activateVoice = useCallback(() => {
    if (isVoiceActive || voiceRoom.roomState === 'connecting' || !isFocused) return;

    callOwnerRef.current = owner;
    hasConnectedRef.current = false;
    setIsVoiceActive(true);
    voiceRoom.connect();
  }, [isVoiceActive, voiceRoom.roomState, voiceRoom, isFocused, owner]);

  const deactivateVoice = useCallback(() => {
    voiceRoom.disconnect();
    setIsVoiceActive(false);
    hasConnectedRef.current = false;
    callOwnerRef.current = null;

    // Every turn and every spoken answer was billed per call.
    queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });

    onDeactivate?.();
  }, [voiceRoom, queryClient, onDeactivate]);

  return {
    // Voice state
    isVoiceActive,
    activateVoice,
    deactivateVoice,

    // Voice loop state (for controls & overlay)
    roomState: voiceRoom.roomState,
    agentState: voiceRoom.agentState,
    isMuted: voiceRoom.isMuted,
    isConnected: voiceRoom.isConnected,

    // Voice loop controls
    toggleMute: voiceRoom.toggleMute,

    // Audio visualization
    waveAmplitude,
    captureLevel,
    playbackLevel,
  };
}
