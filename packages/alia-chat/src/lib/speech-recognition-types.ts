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
   * Android: the recognition service to use, by package, instead of the
   * system's default. `chooseSpeechRecognizer` picks it.
   */
  readonly service?: string;
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

/**
 * What to start a session with, decided before the first one opens.
 *
 * `silent` is set when the device has recognition services and every one of
 * them, asked, named no language at all. A `language-not-supported` from such
 * a device is not about the language: nothing on it recognizes speech (a Pixel
 * without Google's speech services, whose remaining service has no language
 * pack). Where nobody could be asked — the web, iOS — it is `false` and a
 * language error stays one.
 */
export type SpeechRecognizerChoice =
  | { readonly lang: string; readonly service?: string; readonly silent: boolean }
  | { readonly failure: SpeechRecognitionFailure };

/**
 * The tag in `offered` that recognizes `lang`: the same tag (`en-US`, however
 * the service spells it — `en_US`, `en-us`), else another region of the same
 * language (`es-US` for `es-ES`), else `null`.
 */
export function matchSpeechLocale(lang: string, offered: readonly string[]): string | null {
  const norm = (tag: string) => tag.replace(/_/g, '-').toLowerCase();
  const wanted = norm(lang);
  const exact = offered.find((tag) => norm(tag) === wanted);
  if (exact !== undefined) return exact;
  const language = wanted.split('-')[0];
  return offered.find((tag) => norm(tag).split('-')[0] === language) ?? null;
}
