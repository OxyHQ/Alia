/**
 * DigitalOcean Async-Invoke Helper
 *
 * Encapsulates the 3-step async pattern used by DigitalOcean Gradient
 * for non-chat models (TTS, image generation, audio generation).
 *
 * Flow: POST async-invoke → poll status → GET result
 */

import { log } from '../../../lib/logger.js';

const DO_BASE = 'https://inference.do-ai.run';
const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 45_000;

type AsyncStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

interface AsyncInvokeResponse {
  request_id: string;
  status: AsyncStatus;
  model_id: string;
  output: any;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface DOAsyncInvokeOptions {
  apiKey: string;
  modelId: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/**
 * Execute a DigitalOcean async-invoke call and wait for completion.
 *
 * 1. POST /v1/async-invoke  → get request_id
 * 2. Poll GET /v1/async-invoke/{id}/status until COMPLETED/FAILED
 * 3. GET /v1/async-invoke/{id} → return output
 */
export async function callDigitalOceanAsyncInvoke(
  options: DOAsyncInvokeOptions
): Promise<any> {
  const { apiKey, modelId, input, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const headers = authHeaders(apiKey);

  // Step 1: Submit async job
  const submitRes = await fetch(`${DO_BASE}/v1/async-invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model_id: modelId, input }),
    signal,
  });

  if (!submitRes.ok) {
    const errBody = await submitRes.text().catch(() => `HTTP ${submitRes.status}`);
    throw new Error(`DO async-invoke submit ${submitRes.status}: ${errBody}`);
  }

  const submitData = (await submitRes.json()) as AsyncInvokeResponse;
  const { request_id } = submitData;

  log.general.debug({ modelId, request_id }, 'DO async-invoke submitted');

  // Step 2: Poll for completion
  let pollCount = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    await sleep(POLL_INTERVAL_MS, signal);
    pollCount++;

    const statusRes = await fetch(`${DO_BASE}/v1/async-invoke/${request_id}/status`, {
      headers,
      signal,
    });

    if (!statusRes.ok) {
      log.general.warn({ request_id, status: statusRes.status, pollCount }, 'DO async-invoke status poll failed');
      continue; // retry poll on transient errors
    }

    const statusData = (await statusRes.json()) as { status: AsyncStatus };

    if (statusData.status === 'COMPLETED') {
      log.general.debug({ request_id, pollCount }, 'DO async-invoke completed');
      break;
    }

    if (statusData.status === 'FAILED') {
      throw new Error(`DO async-invoke FAILED for ${modelId} (request_id: ${request_id})`);
    }

    // QUEUED or PROCESSING — continue polling
  }

  if (Date.now() >= deadline) {
    throw new Error(`DO async-invoke timeout after ${timeoutMs}ms for ${modelId} (request_id: ${request_id}, polls: ${pollCount})`);
  }

  // Step 3: Fetch result
  const resultRes = await fetch(`${DO_BASE}/v1/async-invoke/${request_id}`, {
    headers,
    signal,
  });

  if (!resultRes.ok) {
    const errBody = await resultRes.text().catch(() => `HTTP ${resultRes.status}`);
    throw new Error(`DO async-invoke result fetch ${resultRes.status}: ${errBody}`);
  }

  const result = (await resultRes.json()) as AsyncInvokeResponse;

  if (result.status !== 'COMPLETED' || result.error) {
    throw new Error(`DO async-invoke result error: ${result.error || 'unexpected status ' + result.status}`);
  }

  return result.output;
}

/**
 * Download binary content from a URL (e.g., audio file from TTS result).
 */
export async function downloadBinaryFromUrl(
  url: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to download from ${url}: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
