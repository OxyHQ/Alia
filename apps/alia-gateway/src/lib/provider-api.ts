/**
 * Provider API - Internal system for making non-streaming API calls to providers.
 *
 * This is the equivalent of proxy() (which handles streaming chat) but for
 * direct API calls like image generation, embeddings, and transcription.
 *
 * Features call this function — they never touch keys, provider URLs, or auth
 * headers. The internal system handles key selection, retries, and error recording.
 */

import { getBestKeyForModel, recordKeySuccess, recordKeyFailure, recordKeyUsage, markKeyCreditExhausted } from './key-manager';
import { classifyError, toAliaError } from './errors/failover-error';
import { log } from './logger';
import { callDigitalOceanAsyncInvoke, downloadBinaryFromUrl, extractAudioUrl } from './digitalocean-async';
import type { FailoverReason } from './errors/error-codes';
import {
  TIER_MODEL_MAPPINGS,
  getAliaModel,
  isAliaModel,
  type ModelMapping,
} from './alia-models';
import { isProviderAvailable, recordFailure, recordSuccess } from './provider-health';
import { FallbackEvent } from '../models/fallback-event.js';

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

// Reasons that should not advance to another provider (caller must fix request)
const NON_PROVIDER_RETRYABLE: Set<FailoverReason> = new Set(['format', 'content_filter']);

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

export interface AliaModelAPIOptions extends Omit<ProviderAPIOptions, 'provider' | 'modelId'> {
  model: string;            // Alia model id (alias)
  maxProviderAttempts?: number; // Max providers to try (default: all for the tier)
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

  const baseUrl = PROVIDER_BASES[provider];
  if (!baseUrl) {
    throw new Error(`Provider "${provider}" has no configured base URL`);
  }

  const url = `${baseUrl}${endpoint}`;
  let lastReason: FailoverReason = 'unknown';
  let lastMessage = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now();
    if (externalSignal?.aborted) {
      lastReason = 'timeout';
      lastMessage = 'Request aborted by caller';
      break;
    }

    const keyConfig = await getBestKeyForModel(provider, modelId);
    if (!keyConfig) {
      log.keys.warn({ provider, modelId, attempt }, 'No keys available');
      break;
    }
    const keyId = keyConfig.keyId ?? `${provider}-unknown`;

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
        await Promise.all([
          recordKeyUsage(keyId, 0, provider, modelId),
          recordKeySuccess(keyId),
        ]);
        recordSuccess(provider, modelId, Date.now() - attemptStart).catch(() => {});

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

      // Standard synchronous provider call
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

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: fetchBody,
        signal: combinedSignal,
      });

      if (timer) clearTimeout(timer);

      if (!response.ok) {
        let errBody = '';
        try {
          errBody = await response.text();
        } catch {
          errBody = `HTTP ${response.status} (body unreadable)`;
        }
        const reason = classifyError({ status: response.status, message: errBody });

        log.keys.warn({ attempt, provider, modelId, status: response.status, reason }, 'Provider API call failed');

        lastReason = reason;
        lastMessage = errBody;

        if (reason === 'billing') {
          await markKeyCreditExhausted(keyId);
        } else {
          await recordKeyFailure(keyId, `${modelId} ${response.status}: ${errBody.slice(0, 200)}`);
        }

        recordFailure(provider, modelId, `${response.status}`).catch(() => {});

        if (NON_RETRYABLE.has(reason)) {
          break;
        }

        continue;
      }

      // Success
      await Promise.all([
        recordKeyUsage(keyId, 0, provider, modelId),
        recordKeySuccess(keyId),
      ]);
      recordSuccess(provider, modelId, Date.now() - attemptStart).catch(() => {});

      if (options.responseType === 'arrayBuffer') {
        const buffer = Buffer.from(await response.arrayBuffer());
        return buffer as unknown as T;
      }

      const data = await response.json() as T;
      return data;

    } catch (fetchErr: unknown) {
      if (timer) clearTimeout(timer);
      const errObj = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
      const isTimeout = errObj.name === 'AbortError';
      log.keys.warn({ attempt, provider, modelId, err: errObj, isTimeout }, 'Provider API fetch error');
      await recordKeyFailure(keyId, `${modelId} ${isTimeout ? 'timeout' : 'fetch'}: ${errObj.message.slice(0, 200)}`);
      recordFailure(provider, modelId, isTimeout ? 'timeout' : errObj.name || 'fetch_error').catch((err: unknown) => {
        log.keys.warn({ err }, 'Failed to record provider failure');
      });
      lastReason = isTimeout ? 'timeout' : 'unknown';
      lastMessage = errObj.message || 'Network error';
      continue;
    }
  }

  // All attempts exhausted
  const error = new Error(`Provider API exhausted: ${provider}/${modelId} (${lastReason})`) as Error & { reason: FailoverReason; providerMessage: string };
  error.reason = lastReason;
  error.providerMessage = lastMessage;
  throw error;
}

// ============== ALIA MODEL FALLBACK WRAPPER ==============

interface ProviderAttempt {
  provider: string;
  modelId: string;
  reason: FailoverReason;
  error: string;
  latencyMs: number;
}

interface AliaModelAPIResult<T> {
  data: T;
  attempts: ProviderAttempt[];
  finalProvider: string;
  finalModelId: string;
  usedFallback: boolean;
}

/**
 * Call a provider API using an Alia model alias with cross-provider fallback.
 *
 * - Iterates tier mappings by priority.
 * - For each mapping, calls callProviderAPI (which handles key rotation + per-provider retries).
 * - On non-retryable reasons (format/content_filter), stop immediately.
 * - On retryable reasons (timeout, rate_limit, billing, auth, unknown), advance to next provider.
 */
export async function callAliaModelAPI<T = any>(options: AliaModelAPIOptions): Promise<AliaModelAPIResult<T>> {
  const {
    model,
    endpoint,
    body,
    formData,
    maxAttempts,
    timeout,
    responseType,
    signal,
    maxProviderAttempts,
  } = options;

  const aliaModel = isAliaModel(model) ? getAliaModel(model) : getAliaModel('alia-v1');
  if (!aliaModel) {
    throw toAliaError(new Error('Invalid model'), { provider: 'alia', model });
  }

  // If caller passed a concrete provider/model in the alias field, just try that once
  if (!isAliaModel(model) && model.includes('/')) {
    const [explicitProvider, ...rest] = model.split('/');
    const explicitModel = rest.join('/');
    const attemptStart = Date.now();
    try {
      const data = await callProviderAPI<T>({
        provider: explicitProvider,
        modelId: explicitModel,
        endpoint,
        body,
        formData,
        maxAttempts,
        timeout,
        responseType,
        signal,
      });
      recordFallbackEvent(model, [], explicitProvider, explicitModel, true, Date.now() - attemptStart);
      return {
        data,
        attempts: [],
        finalProvider: explicitProvider,
        finalModelId: explicitModel,
        usedFallback: false,
      };
    } catch (err: any) {
      const reason: FailoverReason = err?.reason ?? classifyError(err);
      const latencyMs = Date.now() - attemptStart;
      recordFallbackEvent(
        model,
        [{ provider: explicitProvider, model: explicitModel, error: err?.message || String(err), reason, latencyMs }],
        null,
        null,
        false,
        latencyMs,
      );
      throw err;
    }
  }

  const mappings = TIER_MODEL_MAPPINGS[aliaModel.tier] ?? [];
  const sorted = [...mappings].sort((a, b) => a.priority - b.priority);
  const limit = maxProviderAttempts && maxProviderAttempts > 0
    ? Math.min(maxProviderAttempts, sorted.length)
    : sorted.length;

  if (limit === 0) {
    throw toAliaError(new Error('No providers available for this model tier'), { provider: 'alia', model });
  }

  const attempts: ProviderAttempt[] = [];
  const start = Date.now();

  for (let i = 0; i < limit; i++) {
    const mapping: ModelMapping = sorted[i];

    const available = await isProviderAvailable(mapping.provider, mapping.modelId);
    if (!available) {
      attempts.push({
        provider: mapping.provider,
        modelId: mapping.modelId,
        reason: 'unknown',
        error: 'Circuit breaker open',
        latencyMs: 0,
      });
      continue;
    }

    const attemptStart = Date.now();
    try {
      const data = await callProviderAPI<T>({
        provider: mapping.provider,
        modelId: mapping.modelId,
        endpoint,
        body,
        formData,
        maxAttempts,
        timeout,
        responseType,
        signal,
      });

      recordFallbackEvent(
        model,
        attempts.map((a) => ({
          provider: a.provider,
          model: a.modelId,
          error: a.error,
          reason: a.reason,
          latencyMs: a.latencyMs,
        })),
        mapping.provider,
        mapping.modelId,
        true,
        Date.now() - start,
      );

      return {
        data,
        attempts,
        finalProvider: mapping.provider,
        finalModelId: mapping.modelId,
        usedFallback: i > 0 || attempts.length > 0,
      };
    } catch (err: any) {
      const reason: FailoverReason = err?.reason ?? classifyError(err);
      const latencyMs = Date.now() - attemptStart;
      attempts.push({
        provider: mapping.provider,
        modelId: mapping.modelId,
        reason,
        error: err?.providerMessage || err?.message || String(err),
        latencyMs,
      });

      // Non-provider-retryable reasons: stop and bubble
      if (NON_PROVIDER_RETRYABLE.has(reason)) {
        break;
      }

      // Retryable: move to next mapping
      continue;
    }
  }

  recordFallbackEvent(
    model,
    attempts.map((a) => ({
      provider: a.provider,
      model: a.modelId,
      error: a.error,
      reason: a.reason,
      latencyMs: a.latencyMs,
    })),
    null,
    null,
    false,
    Date.now() - start,
  );

  const err = toAliaError(new Error('All providers exhausted'), {
    provider: 'alia',
    model,
  });
  throw err;
}
