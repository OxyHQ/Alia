/**
 * Speech synthesis — the single multi-provider TTS path.
 *
 * Walks the `v1-tts` tier mappings in priority order and returns the first
 * provider that produces audio, exactly like chat completions fail over across
 * available providers. Voice names are translated into each provider's namespace
 * before the call, and the actual output format is returned alongside the audio
 * (Gemini yields WAV, others MP3/the requested format) so the caller can store it
 * with the correct extension and content type.
 *
 * Both the read-aloud endpoint and the show pipeline call this — there is no other
 * TTS provider loop.
 *
 * ## It is also where a bracketed cue is decided
 *
 * `[laughs]` is a tag a tag-capable model PERFORMS and an ordinary one reads out
 * loud, so the right thing to send depends on which model answers — and because
 * this loop fails over, that is not known until it picks one. `speakableText`
 * is therefore applied per mapping, never once by a caller: a show pipeline
 * stripping at script time would take the tag away from the one model that
 * could have voiced it, and one that stripped nothing would have Gemini say the
 * word "laughs".
 */

import { getModelMappingsForTier, callProviderAPI, getProviderTimeout } from './gateway-client.js';
import { resolveVoiceForProvider, speakableText, ttsOutputFormat } from '../internal/providers/lib/tts-providers.js';
import { log } from './logger.js';

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

/**
 * Synthesize speech, failing over across every provider in the TTS tier that has
 * an available key. Returns null only when every provider is exhausted.
 */
export async function synthesizeSpeech(options: SynthesizeSpeechOptions): Promise<SynthesizedSpeech | null> {
  const { input, voice, format, speed, signal } = options;
  const mappings = await getModelMappingsForTier('v1-tts');

  for (const mapping of mappings) {
    if (signal?.aborted) break;

    /**
     * Prepared PER MAPPING, and that is the whole point of doing it here.
     *
     * A `[laughs]` reaches a model that performs it intact and reaches one that
     * does not without it. Nothing upstream can make that choice: the tier
     * fails over, so the model that serves is not known until this loop picks
     * it, and a show pipeline stripping at script time would take the tag away
     * from the one model that could have voiced it.
     */
    /**
     * `=== true`, and that is the invariant rather than a way past the type.
     *
     * `ModelMapping.capabilities` is `Record<string, unknown>` because this
     * module is the seam a remote catalogue arrives through and cannot promise
     * what it carries. Anything that is not literally `true` — absent, a string,
     * a catalogue that has never heard of the field — has to read as "cannot
     * perform a tag", because the cost of guessing wrong in that direction is a
     * voice saying the word "laughs" out loud.
     */
    const spoken = speakableText(input, { audioTags: mapping.capabilities.audioTags === true });
    if (spoken === '') {
      // This model has nothing it can say for this line — a cue-only line at a
      // model that cannot perform cues. The next one may still manage it, and
      // an empty `input` is a 400 at every provider in the tier.
      continue;
    }

    try {
      const audio = await callProviderAPI<Buffer>({
        provider: mapping.provider,
        modelId: mapping.modelId,
        endpoint: '/v1/audio/speech',
        body: {
          model: mapping.modelId,
          input: spoken,
          voice: resolveVoiceForProvider(mapping.provider, voice),
          response_format: format,
          speed: speed ?? 1.0,
        },
        responseType: 'arrayBuffer',
        maxAttempts: 1,
        timeout: getProviderTimeout(mapping.modelId),
        signal,
      });

      if (audio && audio.length > 0) {
        return { audio, format: ttsOutputFormat(mapping.provider, format) };
      }
    } catch (err: unknown) {
      log.general.warn({ err, provider: mapping.provider, model: mapping.modelId }, 'TTS provider failed, trying next');
      continue;
    }
  }

  return null;
}
