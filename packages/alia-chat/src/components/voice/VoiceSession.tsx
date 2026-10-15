/**
 * A live voice call, mounted only while voice mode is on.
 *
 * The chat shell receives it as the `voiceSession` prop rather than importing
 * it, so a text-only consumer never compiles the call, its audio engine or
 * the call UI — which is the reason the `@alia.onl/sdk/voice` entry exists.
 *
 * Mounting starts the call; unmounting ends it (`useVoiceRoom` stops listening
 * and speaking on unmount), so the shell only has to decide whether to render it.
 */

import { useEffect, useRef } from 'react';
import { useVoiceRoom } from '../../hooks/useVoiceRoom';
import { VOICE_ERROR_MESSAGES } from '../../lib/speech-messages';
import { useAudioLevelMonitor } from '../../hooks/useAudioLevelMonitor';
import { useAudioLevels } from '../../hooks/useAudioLevels';
import { VoiceControls } from './VoiceControls';
import type { VoiceSessionProps } from '../../types';

export function VoiceSession({
  apiUrl,
  conversationId,
  agentId,
  locale,
  voice,
  onStateChange,
  onEnd,
}: VoiceSessionProps) {
  const {
    room,
    callState,
    roomState,
    agentState,
    isMuted,
    error,
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

  // End the call on failure, or once a call we actually reached ends. The
  // "reached" flag is what keeps the pre-connect `disconnected` state — which
  // every session starts in — from ending the call before it begins.
  const reachedRoomRef = useRef(false);
  useEffect(() => {
    if (roomState !== 'disconnected') reachedRoomRef.current = true;
    if (error || roomState === 'error') {
      onEnd(error ?? VOICE_ERROR_MESSAGES['realtime-failed']);
      return;
    }
    if (roomState === 'disconnected' && reachedRoomRef.current) onEnd();
  }, [error, roomState, onEnd]);

  return (
    <VoiceControls
      roomState={roomState}
      agentState={agentState}
      isMuted={isMuted}
      onToggleMute={toggleMute}
      onEnd={onEnd}
      callState={callState}
    />
  );
}
