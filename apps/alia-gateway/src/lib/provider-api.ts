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
import { classifyError } from './errors/failover-error';
import { log } from './logger';
import type { FailoverReason } from './errors/error-codes';

// Provider base URLs — internal knowledge
const PROVIDER_BASES: Record<string, string> = {
  openai: 'https://api.openai.com',
  groq: 'https://api.groq.com/openai',
};

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
  const { provider, modelId, endpoint, body, formData, maxAttempts = 3, timeout } = options;

  const baseUrl = PROVIDER_BASES[provider];
  if (!baseUrl) {
    throw new Error(`Provider "${provider}" has no configured base URL`);
  }

  const url = `${baseUrl}${endpoint}`;
  let lastReason: FailoverReason = 'unknown';
  let lastMessage = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const keyConfig = await getBestKeyForModel(provider, modelId);
    if (!keyConfig) {
      log.keys.warn({ provider, modelId, attempt }, 'No keys available');
      break;
    }
    const keyId = keyConfig.keyId ?? `${provider}-unknown`;

    const controller = timeout ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : undefined;

    try {
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
        signal: controller?.signal,
      });

      if (timer) clearTimeout(timer);

      if (!response.ok) {
        const errBody = await response.text();
        const reason = classifyError({ status: response.status, message: errBody });

        log.keys.warn({ attempt, provider, modelId, status: response.status, reason }, 'Provider API call failed');

        lastReason = reason;
        lastMessage = errBody;

        if (reason === 'billing') {
          await markKeyCreditExhausted(keyId);
        } else {
          await recordKeyFailure(keyId, `${modelId} ${response.status}: ${errBody.slice(0, 200)}`);
        }

        if (NON_RETRYABLE.has(reason)) {
          break;
        }

        continue;
      }

      // Success
      const data = await response.json() as T;
      await recordKeyUsage(keyId, 0, provider, modelId);
      await recordKeySuccess(keyId);
      return data;

    } catch (fetchErr: any) {
      if (timer) clearTimeout(timer);
      const isTimeout = fetchErr?.name === 'AbortError';
      log.keys.warn({ attempt, provider, modelId, err: fetchErr, isTimeout }, 'Provider API fetch error');
      await recordKeyFailure(keyId, `${modelId} ${isTimeout ? 'timeout' : 'fetch'}: ${fetchErr?.message?.slice(0, 200)}`);
      lastReason = isTimeout ? 'timeout' : 'unknown';
      lastMessage = fetchErr?.message || 'Network error';
      continue;
    }
  }

  // All attempts exhausted
  const error: any = new Error(`Provider API exhausted: ${provider}/${modelId} (${lastReason})`);
  error.reason = lastReason;
  error.providerMessage = lastMessage;
  throw error;
}
