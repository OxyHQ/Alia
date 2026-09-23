/**
 * The one shape on-device speech recognition has in this package.
 *
 * Two engines sit behind it and neither leaks through: the browser's Web
 * Speech API (`speech-recognition.ts`, picked by web bundlers and by tests) and
 * `expo-speech-recognition` on iOS and Android (`speech-recognition.native.ts`,
 * picked by Metro's platform resolution). Dictation and the voice loop are
 * written against this file only, so the audio never leaves the device through
 * Alia — there is no transcription endpoint, and nothing here posts audio
 * anywhere. Whether the ENGINE uses a network service is the platform's
 * business and is stated in `docs/voice.mdx`.
 */

/** Why a recognition session failed, in the vocabulary both engines share. */
export type SpeechRecognitionFailureCode =
  /** Microphone or speech-recognition permission was refused. */
  | 'not-allowed'
  /** No microphone, or it could not be opened. */
  | 'audio-capture'
  /** The engine needed the network and could not reach it. */
  | 'network'
  /** The engine does not recognize this language. */
  | 'language-not-supported'
  /** Nothing was said before the engine gave up. Recoverable: start again. */
  | 'no-speech'
  /** The session was aborted on purpose. Never an error to report. */
  | 'aborted'
  /** Recognition is not available on this device or in this browser. */
  | 'unsupported'
  /** Anything else — the engine was busy, interrupted, or said nothing useful. */
  | 'other';

export interface SpeechRecognitionFailure {
  readonly code: SpeechRecognitionFailureCode;
  /** The engine's own words, for logs. Never shown as-is. */
  readonly detail?: string;
}

export interface SpeechRecognitionHandlers {
  /**
   * The whole of what this session has heard so far, and whether the engine
   * considers it settled. It is the FULL transcript each time, never a delta:
   * both engines revise earlier words as more audio arrives.
   */
  onResult(result: { transcript: string; isFinal: boolean }): void;
  /** Input level, 0..1, on the same scale as dictation's metering. */
  onLevel?(level: number): void;
  onError(failure: SpeechRecognitionFailure): void;
  /** The session is over, whichever way it ended. Always the last call. */
  onEnd(): void;
}

export interface SpeechRecognitionOptions {
  /** BCP-47 tag, e.g. `es-ES`. */
  readonly lang: string;
  /**
   * Remove the device's own playback from what the microphone hears, where the
   * platform can (iOS voice processing). Voice mode listens while it speaks,
   * so without this it can hear itself.
   */
  readonly echoCancellation?: boolean;
}

export interface SpeechRecognitionSession {
  /** Stop listening and deliver a final result, then `onEnd`. */
  stop(): void;
  /** Stop listening and discard; `onEnd` still follows. */
  abort(): void;
}

/** Map a raw 0..1-ish reading to the field's level, clamped. */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.min(1, Math.max(0, level));
}
