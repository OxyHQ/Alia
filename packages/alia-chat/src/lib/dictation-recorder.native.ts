/**
 * Dictation's iOS / Android recorder: the `expo-audio` recorder (already a
 * peer of this SDK), `RecordingPresets.HIGH_QUALITY` in mono with metering on.
 * The clip is m4a/AAC, sent as `audio/mp4`. No new native module: the call's
 * engine (`react-native-audio-api`) is not needed to record a clip.
 */

import { useMemo } from 'react';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { levelFromDbfs } from './audio-level';
import type { DictationClip } from './dictation';
import { DictationRecorderError, type DictationRecorder } from './dictation-recorder-types';

export * from './dictation-recorder-types';

const LEVEL_POLL_MS = 100;

const OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, isMeteringEnabled: true };

export function useDictationRecorder(): DictationRecorder {
  const recorder = useAudioRecorder(OPTIONS);

  return useMemo(() => {
    let levelTimer: ReturnType<typeof setInterval> | null = null;
    let lastDurationMs = 0;
    let recording = false;

    const stopLevels = (): void => {
      if (levelTimer !== null) clearInterval(levelTimer);
      levelTimer = null;
    };
    const releaseSession = (): void => {
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    };

    return {
      async start(onLevel) {
        const permission = await requestRecordingPermissionsAsync().catch(() => null);
        if (!permission?.granted) throw new DictationRecorderError('mic-denied');
        try {
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          await recorder.prepareToRecordAsync();
          recorder.record();
        } catch {
          releaseSession();
          throw new DictationRecorderError('mic-unavailable');
        }
        recording = true;
        lastDurationMs = 0;
        levelTimer = setInterval(() => {
          const status = recorder.getStatus();
          lastDurationMs = status.durationMillis;
          onLevel(typeof status.metering === 'number' ? levelFromDbfs(status.metering) : 0);
        }, LEVEL_POLL_MS);
      },

      async stop(): Promise<DictationClip | null> {
        if (!recording) return null;
        recording = false;
        stopLevels();
        const durationMs = recorder.getStatus().durationMillis || lastDurationMs;
        try {
          await recorder.stop();
        } finally {
          releaseSession();
        }
        const uri = recorder.uri;
        if (!uri) return null;
        return {
          file: { uri, name: 'dictation.m4a', type: 'audio/mp4' },
          mediaType: 'audio/mp4',
          durationMs,
        };
      },

      cancel(): void {
        if (!recording) return;
        recording = false;
        stopLevels();
        void recorder.stop().catch(() => undefined);
        releaseSession();
      },
    };
  }, [recorder]);
}
