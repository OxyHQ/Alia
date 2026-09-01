/** Speech synthesis fails closed until Kaana exposes a TTS seam. */

import { kaanaCapabilityUnavailable } from './inference/hosted-capability-error.js';

export interface SynthesizeSpeechOptions {
  input: string;
  voice: string;
  /** Requested container (mp3, opus, aac, flac). Providers may return a different one. */
  format: string;
  speed?: number;
  signal?: AbortSignal;
}

export interface SynthesizedSpeech {
  audio: Buffer;
  /** The container the audio is actually encoded in (may differ from the request). */
  format: string;
}

/** Refuses without resolving a model, credential or provider. */
export async function synthesizeSpeech(options: SynthesizeSpeechOptions): Promise<SynthesizedSpeech | null> {
  void options;
  throw kaanaCapabilityUnavailable('speech_synthesis');
}
