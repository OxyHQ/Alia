/** Sound effects fail closed until Kaana exposes an audio-generation seam. */

import { kaanaCapabilityUnavailable } from './inference/hosted-capability-error.js';

export interface SynthesizeSoundEffectOptions {
  /** What the effect should sound like, in the script's own words. */
  prompt: string;
  signal?: AbortSignal;
}

export interface SynthesizedSoundEffect {
  audio: Buffer;
  /** The container the audio is actually encoded in. */
  format: string;
}

/** Refuses without resolving a model, credential or provider. */
export async function synthesizeSoundEffect(
  options: SynthesizeSoundEffectOptions,
): Promise<SynthesizedSoundEffect | null> {
  void options;
  throw kaanaCapabilityUnavailable('audio_generation');
}
