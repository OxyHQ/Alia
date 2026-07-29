/**
 * A live LiveKit call, mounted only while voice mode is on.
 *
 * This is the only place the chat UI touches `livekit-client`. The chat shell
 * receives it as the `voiceSession` prop rather than importing it, so a
 * text-only consumer never pulls the LiveKit client into its module graph —
 * which is the whole reason the `@alia.onl/sdk/voice` entry exists.
 *
 * Mounting starts the call; unmounting ends it (`useVoiceRoom` tears the room
 * down on unmount), so the shell only has to decide whether to render it.
 */

import { useEffect, useRef } from 'react';
import { useVoiceRoom } from '../../hooks/useVoiceRoom';
import { useAudioLevelMonitor } from '../../hooks/useAudioLevelMonitor';
import { useAudioLevels } from '../../hooks/useAudioLevels';
import { VoiceControls } from './VoiceControls';
import type { VoiceSessionProps } from '../../types';

export function VoiceSession({ apiUrl, onStateChange, onEnd }: VoiceSessionProps) {
  const {
    room,
    roomState,
    agentState,
    isMuted,
    error,
    messages,
    cohostActive,
    currentSpeaker,
    roundComplete,
    isConnected,
    connect,
    toggleMute,
    enableCohost,
    disableCohost,
    continueCohost,
  } = useVoiceRoom({ apiUrl });

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
    connect();
  }, [connect]);

  useEffect(() => {
    onStateChange({ isConnected, agentState, waveAmplitude, messages });
  }, [isConnected, agentState, waveAmplitude, messages, onStateChange]);

  // End the call on failure, or once a room we actually reached goes away. The
  // "reached" flag is what keeps the pre-connect `disconnected` state — which
  // every session starts in — from ending the call before it begins.
  const reachedRoomRef = useRef(false);
  useEffect(() => {
    if (roomState === 'connected') reachedRoomRef.current = true;
    if (error || roomState === 'error') {
      onEnd();
      return;
    }
    if (roomState === 'disconnected' && reachedRoomRef.current) onEnd();
  }, [error, roomState, onEnd]);

  return (
    <VoiceControls
      roomState={roomState}
      agentState={agentState}
      isMuted={isMuted}
      cohostActive={cohostActive}
      currentSpeaker={currentSpeaker}
      roundComplete={roundComplete}
      onToggleMute={toggleMute}
      onEnableCohost={enableCohost}
      onDisableCohost={disableCohost}
      onContinueCohost={continueCohost}
      onEnd={onEnd}
    />
  );
}
