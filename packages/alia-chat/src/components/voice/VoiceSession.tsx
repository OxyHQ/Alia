/**
 * A live voice call, mounted only while voice mode is on.
 *
 * Mounting starts the call; unmounting ends it (`useVoiceRoom` stops listening
 * and speaking on unmount), so the screen only has to decide whether to render it.
 *
 * It also says what happened, in the chat's language (`labels`): a failure, a call moved to
 * another device or cut by the server, the time limit near. A hang-up says nothing. Every
 * surface that offers a call gets this one, so they cannot disagree.
 */

import { useEffect, useRef } from 'react';
import { useVoiceRoom } from '../../hooks/useVoiceRoom';
import { toastNotice } from '../../hooks/useVoiceLauncher';
import { useAudioLevelMonitor } from '../../hooks/useAudioLevelMonitor';
import { useAudioLevels } from '../../hooks/useAudioLevels';
import { useLabels } from '../../lib/labels';
import { VoiceControls } from './VoiceControls';
import type { VoiceSessionProps } from '../../types';

export function VoiceSession({
  apiUrl,
  conversationId,
  agentId,
  locale,
  voice,
  onMessagesSaved,
  onNotice = toastNotice,
  onStateChange,
  onEnd,
}: VoiceSessionProps) {
  const labels = useLabels();
  const {
    room,
    callState,
    roomState,
    agentState,
    isMuted,
    errorCode,
    endedReason,
    endingSoonMs,
    messages,
    isConnected,
    connect,
    toggleMute,
  } = useVoiceRoom({
    apiUrl,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(locale === undefined ? {} : { lang: locale }),
    ...(voice === undefined ? {} : { voicePreference: voice }),
    ...(onMessagesSaved === undefined ? {} : { onMessagesSaved }),
  });

  const { captureLevel, playbackLevel } = useAudioLevelMonitor(room, isConnected);
  const { waveAmplitude } = useAudioLevels({
    captureLevel,
    playbackLevel,
    agentState,
    isConnected,
  });

  // Dial out once per mount. The ref keeps a new `connect` identity from
  // placing a second call on top of the live one.
  const dialedRef = useRef(false);
  useEffect(() => {
    if (dialedRef.current) return;
    dialedRef.current = true;
    void connect();
  }, [connect]);

  useEffect(() => {
    onStateChange({ isConnected, agentState, waveAmplitude, messages });
  }, [isConnected, agentState, waveAmplitude, messages, onStateChange]);

  // The call is about to reach its time limit: said once, and shown in the bar.
  const notice = endingSoonMs === null ? null : labels.voiceEndingSoon;
  const warnedRef = useRef(false);
  useEffect(() => {
    if (notice === null || warnedRef.current) return;
    warnedRef.current = true;
    onNotice({ kind: 'warning', text: notice });
  }, [notice, onNotice]);

  // End the call on failure, or once a call we actually reached ends. The
  // "reached" flag is what keeps the pre-connect `disconnected` state — which
  // every session starts in — from ending the call before it begins.
  const reachedRoomRef = useRef(false);
  const finishedRef = useRef(false);
  useEffect(() => {
    if (finishedRef.current) return;
    if (roomState !== 'disconnected') reachedRoomRef.current = true;
    if (errorCode !== null || roomState === 'error') {
      finishedRef.current = true;
      onNotice({ kind: 'error', text: labels.voiceError(errorCode ?? 'realtime-failed') });
      onEnd();
      return;
    }
    if (roomState === 'disconnected' && reachedRoomRef.current) {
      finishedRef.current = true;
      // Moved to another device, the time limit, the credits: information. A hang-up: nothing.
      const text = endedReason === null ? null : labels.voiceEnded(endedReason);
      if (text !== null) onNotice({ kind: 'info', text });
      onEnd();
    }
  }, [errorCode, endedReason, roomState, onEnd, onNotice, labels]);

  return (
    <VoiceControls
      roomState={roomState}
      agentState={agentState}
      isMuted={isMuted}
      onToggleMute={toggleMute}
      onEnd={onEnd}
      notice={notice}
      callState={callState}
      labels={labels.voiceControls}
    />
  );
}
