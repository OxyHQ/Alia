/**
 * Dictation's web recorder: `MediaRecorder` over `getUserMedia`, with an
 * `AnalyserNode` on the same stream for the level meter. See
 * `dictation-recorder-types.ts`.
 */

import { useMemo } from 'react';
import { levelFromFrames } from './audio-level';
import { normalizeAudioMediaType, type DictationClip } from './dictation';
import { DictationRecorderError, type DictationRecorder } from './dictation-recorder-types';

export * from './dictation-recorder-types';

const LEVEL_POLL_MS = 100;

/** Opus in WebM where the browser records it (Chromium, Firefox), MP4/AAC on Safari. */
function recordingMimeType(): string | null {
  const Recorder = globalThis.MediaRecorder;
  if (!Recorder) return null;
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (Recorder.isTypeSupported?.(type)) return type;
  }
  return null;
}

export function createWebDictationRecorder(): DictationRecorder {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let context: AudioContext | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;

  const release = (): void => {
    if (levelTimer !== null) clearInterval(levelTimer);
    levelTimer = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    void context?.close().catch(() => undefined);
    stream = null;
    context = null;
  };

  return {
    async start(onLevel) {
      const mimeType = recordingMimeType();
      const media = globalThis.navigator?.mediaDevices;
      if (mimeType === null || !media?.getUserMedia)
        throw new DictationRecorderError('mic-unavailable');
      try {
        stream = await media.getUserMedia({
          audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
        });
      } catch (caught: unknown) {
        const name = (caught as { name?: unknown } | null)?.name;
        throw new DictationRecorderError(
          name === 'NotAllowedError' || name === 'SecurityError' ? 'mic-denied' : 'mic-unavailable',
        );
      }

      const AudioContextCtor = globalThis.AudioContext;
      if (AudioContextCtor) {
        context = new AudioContextCtor();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const frames = new Float32Array(analyser.fftSize);
        levelTimer = setInterval(() => {
          analyser.getFloatTimeDomainData(frames);
          onLevel(levelFromFrames(Array.from(frames)));
        }, LEVEL_POLL_MS);
      }

      chunks = [];
      const active = new MediaRecorder(stream, { mimeType });
      recorder = active;
      active.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      await new Promise<void>((resolve, reject) => {
        active.onstart = () => {
          startedAt = Date.now();
          resolve();
        };
        active.onerror = () => reject(new DictationRecorderError('mic-unavailable'));
        try {
          active.start();
        } catch {
          reject(new DictationRecorderError('mic-unavailable'));
        }
      }).catch((error: unknown) => {
        release();
        throw error;
      });
    },

    stop(): Promise<DictationClip | null> {
      const active = recorder;
      recorder = null;
      if (active === null || active.state === 'inactive') {
        release();
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        active.onstop = () => {
          const durationMs = Date.now() - startedAt;
          const mediaType = normalizeAudioMediaType(active.mimeType || 'audio/webm');
          const blob = new Blob(chunks, { type: mediaType });
          chunks = [];
          release();
          resolve(blob.size === 0 ? null : { file: blob, mediaType, durationMs });
        };
        active.stop();
      });
    },

    cancel(): void {
      const active = recorder;
      recorder = null;
      chunks = [];
      if (active !== null && active.state !== 'inactive') {
        active.onstop = null;
        active.stop();
      }
      release();
    },
  };
}

export function useDictationRecorder(): DictationRecorder {
  return useMemo(() => createWebDictationRecorder(), []);
}
