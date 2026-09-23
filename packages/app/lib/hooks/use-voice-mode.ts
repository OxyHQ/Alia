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
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useVoiceRoom } from '@/lib/hooks/use-voice-room';
import { useAudioLevelMonitor, useAudioLevels, type VoiceTurnSender } from '@alia.onl/sdk/voice';
import { toast } from '@oxy.so/bloom/toast';
import type { Attachment } from '@/lib/stores/global-store';
import type { SendOptions } from '@/lib/hooks/use-streaming-chat';

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
}

export function useVoiceMode({ sendMessage, stopGeneration, onDeactivate }: UseVoiceModeOptions) {
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const queryClient = useQueryClient();

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
      if (voiceRoom.error !== TURN_NOT_SENT) toast.error(voiceRoom.error);
      deactivateVoice();
    } else if (voiceRoom.roomState === 'error') {
      toast.error('Voice connection failed');
      deactivateVoice();
    }
  }, [voiceRoom.error, voiceRoom.roomState, isVoiceActive]);

  // A turn that went wrong without ending the call: say so, keep listening.
  useEffect(() => {
    if (isVoiceActive && voiceRoom.turnError) toast.error(voiceRoom.turnError);
  }, [voiceRoom.turnError, isVoiceActive]);

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
    if (isVoiceActive || voiceRoom.roomState === 'connecting') return;

    hasConnectedRef.current = false;
    setIsVoiceActive(true);
    voiceRoom.connect();
  }, [isVoiceActive, voiceRoom.roomState, voiceRoom]);

  const deactivateVoice = useCallback(() => {
    voiceRoom.disconnect();
    setIsVoiceActive(false);
    hasConnectedRef.current = false;

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
    cohostActive: voiceRoom.cohostActive,
    currentSpeaker: voiceRoom.currentSpeaker,
    roundComplete: voiceRoom.roundComplete,
    isConnected: voiceRoom.isConnected,
    room: voiceRoom.room,

    // Voice loop controls
    toggleMute: voiceRoom.toggleMute,
    enableCohost: voiceRoom.enableCohost,
    disableCohost: voiceRoom.disableCohost,
    continueCohost: voiceRoom.continueCohost,

    // Audio visualization
    waveAmplitude,
    captureLevel,
    playbackLevel,
  };
}
