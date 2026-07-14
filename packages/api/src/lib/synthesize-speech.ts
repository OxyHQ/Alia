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
 */

import { getModelMappingsForTier, callProviderAPI, getProviderTimeout } from './gateway-client.js';
import { resolveVoiceForProvider, ttsOutputFormat } from '../internal/providers/lib/tts-providers.js';
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
    try {
      const audio = await callProviderAPI<Buffer>({
        provider: mapping.provider,
        modelId: mapping.modelId,
        endpoint: '/v1/audio/speech',
        body: {
          model: mapping.modelId,
          input,
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
