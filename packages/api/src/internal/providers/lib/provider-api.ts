/**
 * Provider API - Internal system for making non-streaming API calls to providers.
 *
 * This is the equivalent of proxy() (which handles streaming chat) but for
 * direct API calls like image generation, embeddings, and transcription.
 *
 * Features call this function — they never touch keys, provider URLs, or auth
 * headers. The internal system handles key selection, retries, and error recording.
 */

import { getBestKeyForModel, recordKeySuccess, recordKeyFailure, recordKeyUsage, markKeyCreditExhausted } from './key-manager.js';
import { readProviderErrorBody, redactProviderText } from './provider-error-body.js';
import { classifyError } from '../../../lib/errors/failover-error.js';
import { log } from '../../../lib/logger.js';
import { callDigitalOceanAsyncInvoke, downloadBinaryFromUrl, extractAudioUrl } from './digitalocean-async.js';
import { pcmToWav, parsePcmSampleRate } from './tts-providers.js';
import type { FailoverReason } from '../../../lib/errors/error-codes.js';

// Default Gemini prebuilt voice when the caller supplies none (voice translation
// to a Gemini voice name happens upstream in the TTS synthesis helper).
const GEMINI_DEFAULT_VOICE = 'Kore';

// Narrow shape of a Gemini generateContent TTS response.
interface GeminiInlineData {
  mimeType?: string;
  data?: string;
}
interface GeminiTtsResponse {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: GeminiInlineData }> } }>;
}

// Provider base URLs — internal knowledge
const PROVIDER_BASES: Record<string, string> = {
  openai: 'https://api.openai.com',
  groq: 'https://api.groq.com/openai',
  openrouter: 'https://openrouter.ai/api',
  digitalocean: 'https://inference.do-ai.run',
};

// DigitalOcean fal-ai models use the async-invoke pattern instead of direct endpoints
function isDOAsyncInvokeModel(modelId: string): boolean {
  return modelId.startsWith('fal-ai/');
}

// Default ElevenLabs voice ID for DO TTS
const DO_ELEVENLABS_DEFAULT_VOICE = 'kPzsL2i3teMYv0FxEYQ6';

/**
 * The same voice, for the DIRECT ElevenLabs provider, and the container it is
 * asked for. `mp3_44100_128` is ElevenLabs' own default and is what
 * `ttsOutputFormat` promises the caller for this provider.
 */
const ELEVENLABS_DEFAULT_VOICE = DO_ELEVENLABS_DEFAULT_VOICE;
const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';

/**
 * Build the async-invoke input object from the standard callProviderAPI body.
 * Translates OpenAI-compatible request bodies to DO async-invoke input format.
 */
function buildAsyncInvokeInput(modelId: string, endpoint: string, body: any): Record<string, unknown> {
  // TTS: OpenAI body { input, voice, ... } → DO input { text, voice }
  if (endpoint === '/v1/audio/speech' || modelId.includes('tts')) {
    return {
      text: body?.input ?? '',
      voice: body?.voice || DO_ELEVENLABS_DEFAULT_VOICE,
    };
  }

  // Image generation: OpenAI body { prompt, size, n, ... } → DO input { prompt, ... }
  if (endpoint === '/v1/images/generations' || modelId.includes('sdxl') || modelId.includes('flux')) {
    return {
      prompt: body?.prompt ?? '',
      ...(body?.num_images && { num_images: body.num_images }),
      ...(body?.n && { num_images: body.n }),
    };
  }

  // Audio generation: pass input through
  if (modelId.includes('audio')) {
    return body?.input ?? body ?? {};
  }

  // Fallback: pass body.input or entire body
  return body?.input ?? body ?? {};
}

// Non-retryable error reasons (a different key won't help)
const NON_RETRYABLE: Set<FailoverReason> = new Set(['format', 'content_filter']);

export interface ProviderAPIOptions {
  provider: string;
  modelId: string;
  endpoint: string;         // e.g. '/v1/images/generations'
  body?: any;               // JSON body (mutually exclusive with formData)
  formData?: FormData;      // Multipart body (e.g. Whisper audio)
  maxAttempts?: number;     // Default: 3
  timeout?: number;         // Per-attempt timeout in ms (e.g. 30000 for Whisper)
  responseType?: 'json' | 'arrayBuffer'; // Default: 'json'. Use 'arrayBuffer' for binary responses (TTS audio)
  signal?: AbortSignal;     // External abort signal (e.g. global request timeout)
}

/**
 * Make a non-streaming API call to a provider with automatic key rotation.
 *
 * On failure, classifies the error, records it against the key, and retries
 * with the next available key. Billing errors permanently exhaust the key.
 * Content filter / format errors are not retried (a different key won't help).
 *
 * @throws Error if all keys are exhausted or the error is non-retryable.
 */
export async function callProviderAPI<T = any>(options: ProviderAPIOptions): Promise<T> {
  const { provider, modelId, endpoint, body, formData, maxAttempts = 3, timeout, signal: externalSignal } = options;

  // Base URL is required for the standard synchronous path only. Providers handled
  // by a special branch (DigitalOcean async-invoke, Google Gemini TTS) build their
  // own URL, so a missing base is validated at the point of the standard fetch.
  const baseUrl = PROVIDER_BASES[provider];
  let lastReason: FailoverReason = 'unknown';
  /**
   * Every assignment to this comes from {@link readProviderErrorBody},
   * {@link redactProviderText} or a literal written here — which is what makes
   * it safe to hang off the thrown error as `providerMessage` and to log, and
   * what a new assignment from an unredacted source would break.
   */
  let lastMessage = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (externalSignal?.aborted) {
      lastReason = 'timeout';
      lastMessage = 'Request aborted by caller';
      break;
    }

    const keyConfig = await getBestKeyForModel(provider, modelId);
    if (!keyConfig) {
      // Said rather than left as `unknown`: nothing was asked, so nothing
      // upstream failed, and the thrown message is the only place an operator
      // sees the difference.
      lastReason = 'no_credential';
      lastMessage = `No credential is configured for ${provider}`;
      log.keys.warn({ provider, modelId, attempt }, 'No keys available');
      break;
    }

    const controller = new AbortController();
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : undefined;
    // Combine per-attempt timeout with caller's external signal
    const combinedSignal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

    try {
      // DigitalOcean fal-ai models use the async-invoke pattern
      if (provider === 'digitalocean' && isDOAsyncInvokeModel(modelId)) {
        const asyncInput = buildAsyncInvokeInput(modelId, endpoint, body);
        const output = await callDigitalOceanAsyncInvoke({
          apiKey: keyConfig.key,
          modelId,
          input: asyncInput,
          timeoutMs: timeout,
          signal: combinedSignal,
        });

        if (timer) clearTimeout(timer);
        await recordKeyUsage(keyConfig.keyId, 0, provider, modelId);
        await recordKeySuccess(keyConfig.keyId);

        // For TTS / binary responses: download audio from the output URL
        if (options.responseType === 'arrayBuffer') {
          const audioUrl = extractAudioUrl(output);
          if (!audioUrl) {
            throw new Error(`DO async-invoke: no audio URL in output for ${modelId}`);
          }
          const buffer = await downloadBinaryFromUrl(audioUrl, combinedSignal);
          return buffer as unknown as T;
        }

        return output as T;
      }

      // Google Gemini TTS — not OpenAI-compatible. Uses generateContent with the
      // AUDIO modality and returns raw PCM (base64) that we wrap in a WAV container.
      if (provider === 'google' && (endpoint === '/v1/audio/speech' || modelId.includes('tts'))) {
        // API key travels in a header, never the query string (keys in URLs leak
        // into logs and proxies).
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyConfig.key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: body?.input ?? '' }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: body?.voice || GEMINI_DEFAULT_VOICE },
                },
              },
            },
          }),
          signal: combinedSignal,
        });

        if (timer) clearTimeout(timer);

        if (!geminiRes.ok) {
          const errBody = await readProviderErrorBody(geminiRes, keyConfig.key);
          const reason = classifyError({ status: geminiRes.status, message: errBody });
          log.keys.warn({ attempt, provider, modelId, status: geminiRes.status, reason }, 'Provider API call failed');
          lastReason = reason;
          lastMessage = errBody;
          if (reason === 'billing') {
            await markKeyCreditExhausted(keyConfig.keyId);
          } else {
            await recordKeyFailure(keyConfig.keyId, `${modelId} ${geminiRes.status}: ${errBody.slice(0, 200)}`);
          }
          if (NON_RETRYABLE.has(reason)) break;
          continue;
        }

        const geminiData = (await geminiRes.json()) as GeminiTtsResponse;
        const inline = geminiData.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
        if (!inline?.data) {
          lastReason = 'format';
          lastMessage = 'Gemini TTS returned no audio';
          await recordKeyFailure(keyConfig.keyId, `${modelId} no-audio`);
          break; // a different key won't produce audio
        }

        await recordKeyUsage(keyConfig.keyId, 0, provider, modelId);
        await recordKeySuccess(keyConfig.keyId);

        const pcm = Buffer.from(inline.data, 'base64');
        return pcmToWav(pcm, parsePcmSampleRate(inline.mimeType)) as unknown as T;
      }

      // ElevenLabs TTS — not OpenAI-compatible in any part: the voice is in the
      // PATH, the key is in `xi-api-key` rather than a bearer token, the
      // container is a query parameter, and the response is raw audio.
      if (provider === 'elevenlabs') {
        const voiceId = (body?.voice as string | undefined) || ELEVENLABS_DEFAULT_VOICE;
        const elevenUrl =
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
          `?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
        const elevenRes = await fetch(elevenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Never `Authorization: Bearer` — ElevenLabs ignores it and answers
            // 401, which classifies as `auth` and retires a working key.
            'xi-api-key': keyConfig.key,
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text: body?.input ?? '',
            model_id: modelId,
          }),
          signal: combinedSignal,
        });

        if (timer) clearTimeout(timer);

        if (!elevenRes.ok) {
          const errBody = await readProviderErrorBody(elevenRes, keyConfig.key);
          const reason = classifyError({ status: elevenRes.status, message: errBody });
          log.keys.warn({ attempt, provider, modelId, status: elevenRes.status, reason }, 'Provider API call failed');
          lastReason = reason;
          lastMessage = errBody;
          if (reason === 'billing') {
            await markKeyCreditExhausted(keyConfig.keyId);
          } else {
            await recordKeyFailure(keyConfig.keyId, `${modelId} ${elevenRes.status}: ${errBody.slice(0, 200)}`);
          }
          if (NON_RETRYABLE.has(reason)) break;
          continue;
        }

        const audio = Buffer.from(await elevenRes.arrayBuffer());
        if (audio.length === 0) {
          lastReason = 'format';
          lastMessage = 'ElevenLabs returned no audio';
          await recordKeyFailure(keyConfig.keyId, `${modelId} no-audio`);
          break; // a different key will not produce audio either
        }

        await recordKeyUsage(keyConfig.keyId, 0, provider, modelId);
        await recordKeySuccess(keyConfig.keyId);
        return audio as unknown as T;
      }

      // Standard synchronous provider call
      if (!baseUrl) {
        throw new Error(`Provider "${provider}" has no configured base URL`);
      }

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${keyConfig.key}`,
      };

      let fetchBody: any;
      if (formData) {
        fetchBody = formData;
      } else if (body) {
        headers['Content-Type'] = 'application/json';
        fetchBody = JSON.stringify(body);
      }

      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: fetchBody,
        signal: combinedSignal,
      });

      if (timer) clearTimeout(timer);

      if (!response.ok) {
        // Redacted before anything else touches it, including the classifier:
        // the classifier reads words ("quota", "rate limit", "invalid_api_key")
        // and the redaction removes credential-shaped TOKENS, so the two do not
        // overlap. Classifying the raw body first would mean the unredacted
        // string outlives this line, which is the whole thing being prevented.
        const errBody = await readProviderErrorBody(response, keyConfig.key);
        const reason = classifyError({ status: response.status, message: errBody });

        log.keys.warn({ attempt, provider, modelId, status: response.status, reason }, 'Provider API call failed');

        lastReason = reason;
        lastMessage = errBody;

        if (reason === 'billing') {
          await markKeyCreditExhausted(keyConfig.keyId);
        } else {
          await recordKeyFailure(keyConfig.keyId, `${modelId} ${response.status}: ${errBody.slice(0, 200)}`);
        }

        if (NON_RETRYABLE.has(reason)) {
          break;
        }

        continue;
      }

      // Success
      await recordKeyUsage(keyConfig.keyId, 0, provider, modelId);
      await recordKeySuccess(keyConfig.keyId);

      if (options.responseType === 'arrayBuffer') {
        const buffer = Buffer.from(await response.arrayBuffer());
        return buffer as unknown as T;
      }

      const data = await response.json() as T;
      return data;

    } catch (fetchErr: any) {
      if (timer) clearTimeout(timer);
      const isTimeout = fetchErr?.name === 'AbortError';
      // A transport error's message is not an upstream body, but it can carry
      // the request URL — and a URL is one of the shapes a credential travels
      // in. Same redaction, same reason.
      const fetchMessage = redactProviderText(fetchErr?.message ?? '', keyConfig.key);
      log.keys.warn({ attempt, provider, modelId, err: fetchErr, isTimeout }, 'Provider API fetch error');
      await recordKeyFailure(keyConfig.keyId, `${modelId} ${isTimeout ? 'timeout' : 'fetch'}: ${fetchMessage.slice(0, 200)}`);
      lastReason = isTimeout ? 'timeout' : 'unknown';
      lastMessage = fetchMessage || 'Network error';
      continue;
    }
  }

  // All attempts exhausted
  const error: any = new Error(`Provider API exhausted: ${provider}/${modelId} (${lastReason})`);
  error.reason = lastReason;
  error.providerMessage = lastMessage;
  throw error;
}
