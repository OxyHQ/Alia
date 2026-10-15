/**
 * The seam between a voice call and the device's audio (ADR 0017 §4).
 *
 * One engine captures the microphone and plays the answer, because echo
 * cancellation only cancels what the SAME audio stack plays:
 *
 * - web (`voice-audio-engine.ts`): `getUserMedia` with echo cancellation, noise
 *   suppression and gain control, and two `AudioWorklet`s in one `AudioContext`;
 * - iOS / Android (`voice-audio-engine.native.ts`): `react-native-audio-api`.
 *
 * Audio crosses the seam as PCM16 little-endian, 24 kHz, mono — the format the
 * call carries in both directions — so the call never resamples or converts.
 * Tests drive a call through a fake engine that implements this interface.
 */

/** Why an engine could not start, or stopped working mid-call. */
export type VoiceAudioEngineErrorCode = 'mic-denied' | 'mic-unavailable' | 'voice-unavailable';

export class VoiceAudioEngineError extends Error {
  readonly code: VoiceAudioEngineErrorCode;

  constructor(code: VoiceAudioEngineErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'VoiceAudioEngineError';
    this.code = code;
  }
}

export interface VoiceAudioEngineHandlers {
  /** One captured frame (~40 ms), PCM16 24 kHz mono. */
  onCaptureFrame(pcm16: Uint8Array): void;
  /** The microphone's level, 0..1, from the real captured buffers. */
  onCaptureLevel(level: number): void;
  /** The first sample of `itemId` is audible now — not received, PLAYING. */
  onPlaybackStarted(itemId: string): void;
  /** The level of what is playing, 0..1, from the real played buffers. */
  onPlaybackLevel(level: number): void;
  /** Everything queued has been played. */
  onPlaybackIdle(): void;
  /** The device failed during the call (the microphone went away). */
  onError(error: VoiceAudioEngineError): void;
}

export interface VoiceAudioEngine {
  /**
   * Ask for the microphone and start capturing and the player. Rejects with a
   * {@link VoiceAudioEngineError}.
   */
  start(handlers: VoiceAudioEngineHandlers): Promise<void>;
  /** Queue a chunk of `itemId`'s audio behind what is already queued. */
  enqueue(itemId: string, pcm16: Uint8Array): void;
  /**
   * Drop everything queued and stop playing at once. Resolves with how much of
   * the item that was playing was actually heard, or `null` when nothing was.
   */
  flush(): Promise<{ itemId: string; playedMs: number } | null>;
  /** Release the microphone and the player. Safe to call more than once. */
  stop(): void;
}
