/**
 * Sound effects — the single multi-provider path for the non-speech audio a
 * show's script asks for.
 *
 * Walks the `v1-sfx` tier in priority order and returns the first provider that
 * produces audio, exactly as {@link synthesizeSpeech} walks `v1-tts`. That
 * symmetry is the fix rather than a tidy-up: the show pipeline used to name one
 * provider and one model inline, so the chain was exhausted on its first attempt
 * and there was no second attempt to make. MEASURED in production on 2026-08-24
 * and again on 2026-08-25 — three `no_credential` failures per episode, one per
 * sound cue, on a provider `provider_keys` holds no row for at all, and every
 * episode published without a single effect.
 *
 * ## Why this is a separate loop from speech and not a flag on it
 *
 * They share a shape and nothing else. Speech has a voice, a container, a speed
 * and a per-model decision about bracketed cues; an effect has a prompt and a
 * length. The providers differ too — the one credentialed route here reaches an
 * endpoint that takes no voice — so folding the two into one function would mean
 * a body built from two disjoint halves and a branch at every field.
 */

import { getModelMappingsForTier, callProviderAPI, getProviderTimeout } from './gateway-client.js';
import { log } from './logger.js';

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

/**
 * How long an effect is, in seconds.
 *
 * One number for the whole tier, because it is the ONE parameter both routes
 * express and they spell it differently — `duration_seconds` at ElevenLabs,
 * `seconds_total` at fal — which is translated per provider in
 * `provider-api.ts`. The script writes a length into the prompt text as well
 * ("smooth transition whoosh, 2 seconds"); that is what the model reads, and
 * this is the ceiling the provider is asked for.
 */
const SFX_SECONDS = 5;

/**
 * Every mapping in the chain answers MP3.
 *
 * Not a default and not a guess: ElevenLabs' sound endpoint was MEASURED on
 * 2026-08-25 returning `audio/mpeg` with an ID3v2.4 header, and the fal route
 * hands back an MP3 URL. It is stated here rather than derived per provider —
 * the way `ttsOutputFormat` has to for speech, where Gemini answers WAV —
 * because there is nothing to derive while both agree, and a provider that
 * disagreed would need a row of its own anyway.
 */
const SFX_FORMAT = 'mp3';

/**
 * Generate one sound effect, failing over across every provider in the SFX tier
 * that has an available key. Returns null only when every provider is exhausted.
 */
export async function synthesizeSoundEffect(
  options: SynthesizeSoundEffectOptions,
): Promise<SynthesizedSoundEffect | null> {
  const { prompt, signal } = options;
  const mappings = await getModelMappingsForTier('v1-sfx');

  for (const mapping of mappings) {
    if (signal?.aborted) break;

    try {
      const audio = await callProviderAPI<Buffer>({
        provider: mapping.provider,
        modelId: mapping.modelId,
        endpoint: '/v1/sound-generation',
        // Provider-neutral, and translated at the seam. `prompt` rather than
        // `input` because this is not something anybody says.
        body: { prompt, duration_seconds: SFX_SECONDS },
        responseType: 'arrayBuffer',
        maxAttempts: 1,
        timeout: getProviderTimeout(mapping.modelId),
        signal,
      });

      if (audio && audio.length > 0) {
        return { audio, format: SFX_FORMAT };
      }
    } catch (err: unknown) {
      // `prompt` is model-authored text describing a sound, so it is left out
      // without costing an operator anything they need.
      log.general.warn(
        { err, provider: mapping.provider, model: mapping.modelId },
        'Sound effect provider failed, trying next',
      );
      continue;
    }
  }

  return null;
}
