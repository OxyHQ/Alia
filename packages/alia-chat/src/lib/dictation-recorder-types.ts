import type { DictationClip } from './dictation';

/** Why the microphone could not record. */
export type DictationRecorderErrorCode = 'mic-denied' | 'mic-unavailable';

export class DictationRecorderError extends Error {
  readonly code: DictationRecorderErrorCode;

  constructor(code: DictationRecorderErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'DictationRecorderError';
    this.code = code;
  }
}

/**
 * A clip recorder for the composer's microphone:
 *
 * - web (`dictation-recorder.ts`): `MediaRecorder`, `audio/webm;codecs=opus`
 *   or `audio/mp4` (Safari), level from an `AnalyserNode` on the same stream;
 * - iOS / Android (`dictation-recorder.native.ts`): the `expo-audio`
 *   recorder, `RecordingPresets.HIGH_QUALITY` (m4a/AAC → `audio/mp4`) with
 *   metering on.
 *
 * Levels are the real recorder's, 0..1 on the dictation meter's dBFS scale.
 */
export interface DictationRecorder {
  /**
   * Ask for the microphone and start recording; resolves once the recorder
   * says it started. Rejects with a {@link DictationRecorderError}.
   */
  start(onLevel: (level: number) => void): Promise<void>;
  /** Stop and hand over the clip, or `null` when nothing was recorded. */
  stop(): Promise<DictationClip | null>;
  /** Stop and throw the clip away. */
  cancel(): void;
}
