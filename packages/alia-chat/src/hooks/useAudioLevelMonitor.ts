/**
 * A voice call's live levels, as React state at ~20fps.
 *
 * `useVoiceRoom` writes the microphone level (from the recognizer) and the
 * playback level (from the clip being spoken) into a `VoiceLevelSource`; this
 * reads them on a clock so a wave can follow them without rendering once per
 * audio buffer. It used to put Web Audio analysers on a LiveKit room's tracks;
 * the signature kept its shape — `room` is now the level source `useVoiceRoom`
 * returns under that name.
 */

import { useState, useEffect } from 'react';
import type { VoiceLevelSource } from '../lib/voice-levels';

const POLL_MS = 50;

export function useAudioLevelMonitor(room: VoiceLevelSource | null, isConnected: boolean) {
  const [captureLevel, setCaptureLevel] = useState(0);
  const [playbackLevel, setPlaybackLevel] = useState(0);

  useEffect(() => {
    if (!room || !isConnected) {
      setCaptureLevel(0);
      setPlaybackLevel(0);
      return undefined;
    }

    let dirty = true;
    const unsubscribe = room.subscribe(() => {
      dirty = true;
    });
    const timer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      setCaptureLevel(room.capture);
      setPlaybackLevel(room.playback);
    }, POLL_MS);

    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [room, isConnected]);

  return { captureLevel, playbackLevel };
}
