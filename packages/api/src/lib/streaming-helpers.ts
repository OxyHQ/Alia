import type { Response } from 'express';

/**
 * SSE Streaming Helper
 * Optimized for low-latency, high-throughput Server-Sent Events
 */

/**
 * Setup SSE response headers optimized for streaming
 */
export function setupSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders(); // Immediately send headers to client
}

// ── OpenAI-compatible chunk helpers ──

const THINKING_RE = /<thinking>[\s\S]*?<\/thinking>/g;

/** Strip <thinking> tags, return null if nothing remains. */
function filterThinking(text: string): string | null {
  const f = text.replace(THINKING_RE, '');
  return f || null;
}

/** Build an OpenAI-compatible chat.completion.chunk object. */
export function makeChunk(
  id: string,
  model: string,
  choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason: string | null }>,
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: 'fp_alia',
    service_tier: 'default',
    choices: choices.map(c => ({ ...c, logprobs: null })),
  };
}

/** Write a text-delta SSE chunk with thinking-tag filter. Returns filtered text or null. */
export function writeTextChunk(res: Response, id: string, model: string, text: string): string | null {
  const filtered = filterThinking(text);
  if (!filtered) return null;
  res.write(`data: ${JSON.stringify(makeChunk(id, model, [{ index: 0, delta: { content: filtered }, finish_reason: null }]))}\n\n`);
  return filtered;
}

/** Write a stop/finish SSE chunk. */
export function writeStopChunk(res: Response, id: string, model: string, reason = 'stop'): void {
  res.write(`data: ${JSON.stringify(makeChunk(id, model, [{ index: 0, delta: {}, finish_reason: reason }]))}\n\n`);
}

/**
 * Write a content delta SSE chunk (no thinking filter). `meta` rides along as
 * `alia_meta`, which is how a stand-in message — the graceful text sent when a
 * provider dies mid-stream — tells the client it is not a real answer.
 */
export function writeContentChunk(
  res: Response,
  id: string,
  model: string,
  content: string,
  meta?: Record<string, unknown>,
): void {
  const chunk = makeChunk(id, model, [{ index: 0, delta: { content }, finish_reason: null }]);
  res.write(`data: ${JSON.stringify(meta ? { ...chunk, alia_meta: meta } : chunk)}\n\n`);
}
