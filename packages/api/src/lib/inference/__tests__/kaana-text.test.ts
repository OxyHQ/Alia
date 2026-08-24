import { describe, expect, it, vi } from 'vitest';

/**
 * The one-shot text call product code holds.
 *
 * Two of its inputs decide whether a caller that PARSES the answer gets one it
 * can parse, and both were unsettable until a route found out the hard way:
 * `routes/suggestions.ts` asked a reasoning model for eight JSON objects inside
 * a fixed thirty-second envelope and a 2048-token ceiling, and the model spent
 * most of the ceiling reasoning and returned JSON cut off mid-object. So these
 * cases are about what leaves this function, not about what comes back.
 */

const H = vi.hoisted(() => ({
  sent: null as { context: Record<string, never>; payload: Record<string, unknown> } | null,
  signal: null as AbortSignal | null,
  outputText: 'ok',
}));

vi.mock('../kaana.js', () => ({
  getKaanaClient: () => ({
    generate: async (call: never, signal: AbortSignal) => {
      H.sent = call;
      H.signal = signal;
      return { outputText: H.outputText, reasoningText: '', refusalText: '', finishReason: 'stop', usage: [], toolCalls: [] };
    },
  }),
}));

import { generateTextViaKaana } from '../kaana-text.js';

const request = { prompt: 'hi', surface: 'authoring', maxOutputTokens: 1024 } as const;

/** The envelope's own view of the budget, which is the one Kaana enforces. */
const budget = () => (H.sent?.context as unknown as { budget: Record<string, number> }).budget;

describe('the shape it asks for', () => {
  const responseFormat = {
    type: 'json_schema',
    name: 'prompt_suggestions',
    schema: { type: 'object', properties: { suggestions: { type: 'array' } } },
    strict: false,
  } as const;

  it('carries a response format the caller supplied', async () => {
    await generateTextViaKaana({ ...request, responseFormat });
    expect(H.sent?.payload.responseFormat).toEqual(responseFormat);
  });

  it('omits the field for the callers that want prose', async () => {
    // Not `{type:'text'}`: the contract's absent field and its text member mean
    // the same thing to Kaana, and sending one would put a response format on
    // every call in the product that never asked for one.
    await generateTextViaKaana(request);
    expect(H.sent?.payload).not.toHaveProperty('responseFormat');
  });
});

describe('how long it may take', () => {
  it('spends the budget the caller gave it, on both clocks', async () => {
    // Kaana enforces the envelope's budget and this process enforces the abort
    // signal. A caller able to move one without the other would be moving the
    // one that does not decide.
    await generateTextViaKaana({ ...request, budgetMs: 55_000 });

    expect(budget().totalMs).toBe(55_000);
    expect(budget().firstTokenMs).toBe(27_500);
    expect(budget().idleStreamMs).toBe(27_500);
  });

  it('keeps the thirty seconds it always had when nobody says otherwise', async () => {
    // The values this function was hardcoded to before either was settable, so
    // a caller that passes nothing is unaffected by the field existing.
    await generateTextViaKaana(request);

    expect(budget()).toEqual({ totalMs: 30_000, connectMs: 5_000, firstTokenMs: 15_000, idleStreamMs: 15_000 });
  });

  it('expires its own signal at the budget rather than at thirty seconds', async () => {
    // Measured rather than read off the source: the envelope number above and
    // the signal are two different mechanisms, and a change that moved only the
    // first would still pass every assertion in this file but this one.
    await generateTextViaKaana({ ...request, budgetMs: 5 });
    const short = H.signal;

    await generateTextViaKaana({ ...request, budgetMs: 60_000 });
    const long = H.signal;

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(short?.aborted).toBe(true);
    expect(long?.aborted).toBe(false);
  });

  it('defers to a signal the caller brought, and does not add one of its own', async () => {
    // A caller with a deadline across several calls owns the clock; a second
    // one created here would cancel the last call of a request that still had
    // time on the deadline the caller was counting.
    const caller = new AbortController();
    await generateTextViaKaana({ ...request, signal: caller.signal, budgetMs: 5 });

    expect(H.signal).toBe(caller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(H.signal?.aborted).toBe(false);
  });
});
