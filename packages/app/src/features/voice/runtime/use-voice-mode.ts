/**
 * Voice mode for the open conversation.
 *
 * A call is a realtime speech-to-speech session that Alia holds with Kaana
 * (`/v1/voice/session`, ADR 0017), opened for THIS conversation and its agent.
 * Alia stores both sides of the transcript in the conversation as the call
 * goes, and tells the open screen over the notifications socket
 * (`conversation:message`); `messages.saved` also refreshes the cached thread.
 * Nothing is sent through the screen's `sendMessage`, and nothing is recognized
 * on the device.
 *
 * A call belongs to one conversation of one account, on the screen that shows
 * it. When the screen stops being the one on show (another route pushed over
 * it, the drawer's next chat), the conversation it speaks to changes, or the
 * account does, the call ENDS (`session.end`): the microphone is released and
 * the controls go with it.
 *
 * A call opened on another device or tab takes this one over; this side then
 * ends with `call-moved-elsewhere`, which is said as information, not as an
 * error.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/api/query-keys';
import { useVoiceRoom } from '@/features/voice/runtime/use-voice-room';
import { useAudioLevelMonitor, useAudioLevels } from '@alia.onl/sdk/voice';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from '@/shared/i18n/use-translation';
import { voiceEndedText, voiceErrorText } from '@/features/voice/model/voice-error-text';

interface UseVoiceModeOptions {
  /** The conversation the call speaks in, and is stored in. */
  conversationId: string;
  /** The conversation's agent; omitted, Alia. */
  agentId?: string;
  onDeactivate?: () => void;
  /**
   * Whose call it would be: the conversation and the account, as one key
   * (`conversation-screen.tsx` joins the two ids). A call ends when it changes.
   */
  owner: string;
  /** Whether the screen holding the call is the one on show. A call ends when it is not. */
  isFocused: boolean;
}

export function useVoiceMode({
  conversationId,
  agentId,
  onDeactivate,
  owner,
  isFocused,
}: UseVoiceModeOptions) {
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  /** The owner the live call was started for; `null` while there is none. */
  const callOwnerRef = useRef<string | null>(null);

  const onMessagesSaved = useCallback(
    (savedIn: string) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(savedIn) });
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
    },
    [queryClient],
  );

  const voiceRoom = useVoiceRoom({
    conversationId,
    ...(agentId === undefined ? {} : { agentId }),
    onMessagesSaved,
  });
  const { captureLevel, playbackLevel } = useAudioLevelMonitor(
    voiceRoom.room,
    voiceRoom.isConnected,
  );
  const { waveAmplitude } = useAudioLevels({
    captureLevel,
    playbackLevel,
    agentState: voiceRoom.agentState,
    isConnected: voiceRoom.isConnected,
  });

  const deactivateVoice = useCallback(() => {
    voiceRoom.disconnect();
    setIsVoiceActive(false);
    callOwnerRef.current = null;

    // The call used credits per minute, and its transcript is in the thread.
    queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });
    queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(conversationId) });

    onDeactivate?.();
  }, [voiceRoom, queryClient, conversationId, onDeactivate]);

  // A call that failed says why, in the app's language, and ends.
  useEffect(() => {
    if (!isVoiceActive || voiceRoom.errorCode === null) return;
    toast.error(voiceErrorText(t, voiceRoom.errorCode) ?? t('voice.connectionFailed'));
    deactivateVoice();
  }, [voiceRoom.errorCode, isVoiceActive]);

  // A call that ended on its own (moved to another device, the time limit, the
  // credits) says so as information; a hang-up says nothing.
  useEffect(() => {
    if (!isVoiceActive || voiceRoom.endedReason === null) return;
    const text = voiceEndedText(t, voiceRoom.endedReason);
    if (text !== null) toast.info(text);
    deactivateVoice();
  }, [voiceRoom.endedReason, isVoiceActive]);

  // The call is about to reach its time limit: said once, and shown in the bar.
  const notice = isVoiceActive && voiceRoom.endingSoonMs !== null ? t('voice.endingSoon') : null;
  useEffect(() => {
    if (notice !== null) toast.warning(notice);
  }, [notice]);

  // The call ends when its screen is no longer on show, or when the
  // conversation or the account it was started for is no longer this one.
  useEffect(() => {
    if (!isVoiceActive) return;
    if (!isFocused || owner !== callOwnerRef.current) deactivateVoice();
  }, [isFocused, owner, isVoiceActive]);

  const activateVoice = useCallback(() => {
    if (isVoiceActive || voiceRoom.roomState === 'connecting' || !isFocused) return;
    callOwnerRef.current = owner;
    setIsVoiceActive(true);
    void voiceRoom.connect();
  }, [isVoiceActive, voiceRoom, isFocused, owner]);

  return {
    // Voice state
    isVoiceActive,
    activateVoice,
    deactivateVoice,

    // The call's state (for controls & overlay)
    callState: voiceRoom.callState,
    roomState: voiceRoom.roomState,
    agentState: voiceRoom.agentState,
    isMuted: voiceRoom.isMuted,
    isConnected: voiceRoom.isConnected,
    /** What the call bar says instead of "Listening…" while the call is about to end. */
    notice,

    // Controls
    toggleMute: voiceRoom.toggleMute,

    // Audio visualization
    waveAmplitude,
    captureLevel,
    playbackLevel,
  };
}
