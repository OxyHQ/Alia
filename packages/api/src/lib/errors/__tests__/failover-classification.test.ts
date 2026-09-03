import { describe, expect, it } from 'vitest';

import { classifyError } from '../failover-error.js';

/**
 * A dead MODEL must not retire a KEY.
 *
 * MEASURED against Groq on 2026-08-23. Every mapping in the routing table
 * naming `llama-3.3-70b-versatile` — five of them, one per tier — answers 404
 * with the body below; Groq decommissioned the whole llama-3.3 line and now
 * serves `openai/gpt-oss-20b`, `openai/gpt-oss-120b` and `qwen/qwen3.6-27b`.
 *
 * Before `model_not_found` existed, that body matched no branch in
 * `classifyError` and fell through to `unknown`, whose branch in
 * `fallback-engine.ts` put the failing key in `skipKeyIds`. Groq holds ONE
 * credential, so the rest of the request found "No usable key" for groq — and
 * the LIVE `openai/gpt-oss-20b` mapping at priority 17 of `kaana-lite` was never
 * reached. The user-visible result was `{"error":"No AI models available"}` on
 * a deployment whose only provider credential was working perfectly.
 *
 * The fixture is the response body as Groq actually returned it, not a
 * plausible reconstruction: the message wording is what the regex has to
 * survive, and an invented one ("model not found") would pass while the real
 * one failed.
 */
describe('classifyError: a dead model is not a dead key', () => {
  /**
   * The shape that reaches `classifyError`: the parsed body under `.data` for
   * the structured branch, and the upstream text on `.message` — which is
   * where the AI SDK's `APICallError` puts it and the only place
   * `getErrorMessage` looks.
   */
  function groqError(body: unknown, statusCode: number): Error {
    const upstream =
      typeof body === 'object' && body !== null
        ? (body as { error?: { message?: unknown } }).error?.message
        : undefined;
    return Object.assign(new Error(typeof upstream === 'string' ? upstream : 'groq request failed'), {
      statusCode,
      data: body,
    });
  }

  const GROQ_DECOMMISSIONED = {
    error: {
      message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.',
      type: 'invalid_request_error',
      code: 'model_not_found',
    },
  };

  it('classifies the real Groq 404 as model_not_found, not unknown', () => {
    expect(classifyError(groqError(GROQ_DECOMMISSIONED, 404))).toBe('model_not_found');
  });

  it('classifies it from the MESSAGE alone, for providers that send no code', () => {
    // Positive control for the regex on its own: strip both the `code` the
    // structured branch reads and the 404 the status branch reads, and the
    // message must still carry the classification. Without this the test would
    // pass on the `code` branch alone and the regex would be unmeasured — and
    // `status === 400` falls through to `format`, so a regex that misses here
    // is not merely unmeasured, it is wrong.
    const messageOnly = {
      error: { message: GROQ_DECOMMISSIONED.error.message, type: 'invalid_request_error' },
    };
    expect(classifyError(groqError(messageOnly, 400))).toBe('model_not_found');
  });

  it('classifies a bare 404 with no body as model_not_found', () => {
    expect(classifyError(groqError({}, 404))).toBe('model_not_found');
  });

  it('does NOT reclassify the key-level faults that legitimately retire a key', () => {
    // The negative controls. If `model_not_found` swallowed these, the fix
    // would trade one silent failure for a worse one: a revoked or
    // rate-limited credential kept in service forever.
    expect(classifyError(groqError({ error: { message: 'Invalid API Key' } }, 401))).toBe('auth');
    expect(classifyError(groqError({ error: { message: 'Rate limit reached' } }, 429))).toBe('rate_limit');
    expect(classifyError(groqError({ error: { message: 'Insufficient credits' } }, 402))).toBe('billing');
    expect(classifyError(groqError({ error: { message: 'Internal server error' } }, 500))).toBe(
      'provider_unavailable',
    );
  });

  it('leaves a genuinely unclassifiable error as unknown', () => {
    // The vacuity floor. If everything classified as `model_not_found` this
    // suite would be green and measure nothing.
    expect(classifyError(groqError({ error: { message: 'something went sideways' } }, 418))).toBe(
      'unknown',
    );
  });
});
