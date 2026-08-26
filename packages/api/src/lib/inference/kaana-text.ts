/**
 * One-shot text generation through Kaana, for product code.
 *
 * The client speaks the contract's vocabulary — envelopes, principals, routing
 * policies, stream events. Most of Alia does not need any of that: thirty-odd
 * modules want a string back from a prompt. This is that call, and it is the
 * FIRST product-facing entry to Kaana in this repository.
 *
 * ## Why it answers `null` instead of throwing
 *
 * Two paths exist while the migration runs: Kaana, and the in-process provider
 * tree Kaana replaces. A caller that gets `null` knows Kaana did not serve this
 * request — because the cutover flag is off, because the process is not
 * configured for it, or because the call itself failed — and falls back. The
 * day the in-process tree is deleted, the fallbacks go with it and this starts
 * throwing instead. Until then, an exception here would take out a surface that
 * has a working alternative one line below.
 *
 * ## What it does not do
 *
 * Tools, streaming, images, audio. Kaana's OpenAI-compatible adapter refuses
 * every modality but text today, and the streaming path has its own event
 * contract that the product's stream consumers do not speak yet. Both are
 * deliberate omissions rather than oversights: this is the narrow seam that
 * proves the wire in production, not the whole surface.
 */

import type { ResponseFormat } from '@oxyhq/contracts';

import { getKaanaClient } from './kaana.js';
import type { AliaInferenceContext, AliaInferenceSurface } from './product-seam.js';
import type { KaanaRequestPayload } from './kaana-request.js';

/**
 * How long a call may take when the caller does not say.
 *
 * Also the value both clocks were hardcoded to before either was settable, so
 * a caller that passes nothing gets exactly what it got before.
 */
const DEFAULT_BUDGET_MS = 30_000;

export interface KaanaTextRequest {
  /** The whole instruction. One user turn, because there is no conversation here. */
  readonly prompt: string;
  /** Which product surface is asking, for cost attribution on the receipt. */
  readonly surface: AliaInferenceSurface;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** The Oxy account this is for, or `null` for a call no user is waiting on. */
  readonly oxyUserId?: string | null;
  /**
   * Ask for JSON back rather than prose, where the caller needs a shape.
   *
   * A caller that parses the answer has to send this: without it the model was
   * never asked for the thing being parsed, and the parse is a hope.
   */
  readonly responseFormat?: ResponseFormat;
  /**
   * How long the whole call may take, in milliseconds.
   *
   * One number for two clocks on purpose. Kaana enforces its own deadline from
   * the budget in the envelope and this process enforces one with the abort
   * signal, and a caller that could raise one without the other would be
   * raising the one that does not decide: a longer signal against a 30-second
   * envelope is still cancelled at thirty seconds, by the other end.
   */
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * The generated text, or `null` when Kaana did not serve it.
 *
 * `derived` visibility and `drop` on disconnect: every caller today is a
 * background derivation — a suggestion, a title, a summary — that nobody is
 * watching a spinner for. A user-facing turn wants different answers to both
 * questions and should build its own context rather than inherit these.
 */
export async function generateTextViaKaana(request: KaanaTextRequest): Promise<string | null> {
  const client = getKaanaClient();
  if (client === null) return null;

  const budgetMs = request.budgetMs ?? DEFAULT_BUDGET_MS;

  const context: AliaInferenceContext = {
    surface: request.surface,
    visibility: 'derived',
    caller: {
      oxyUserId: request.oxyUserId ?? null,
      // A derivation nobody asked for is not the user's spend. `platform_cost`
      // is the mode for work the product decided to do on its own behalf.
      billing: 'platform_cost',
      viaApiKey: false,
    },
    model: { kind: 'product_default' },
    conversationId: null,
    fallbackPolicy: null,
    // The two sub-budgets stay at half the total, which is where they were when
    // the total was fixed at thirty seconds. They scale rather than staying put
    // because they measure the same generation: a reasoning model that needs
    // fifty seconds to answer can spend twenty-five of them before its first
    // token, and a `firstTokenMs` frozen at fifteen would cancel it for being
    // slow at the part it was given the extra budget for.
    budget: {
      totalMs: budgetMs,
      connectMs: 5_000,
      firstTokenMs: Math.floor(budgetMs / 2),
      idleStreamMs: Math.floor(budgetMs / 2),
    },
    // Nobody is watching, so a client that goes away takes the call with it
    // rather than finishing work whose result has nowhere to go.
    onDisconnect: 'abort',
  };

  const payload: KaanaRequestPayload = {
    modality: 'text',
    // `messages`, not `text`: the contract reads a bare `text` input as an
    // EMBEDDING input, and a chat model refuses it with `unsupported_modality`.
    input: {
      format: 'messages',
      messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
    },
    maxOutputTokens: request.maxOutputTokens,
    sampling: { temperature: request.temperature ?? 0.7 },
    // Declared empty rather than omitted: the contract distinguishes "this call
    // offers no tools" from "this field was forgotten", and only the first is
    // true here.
    tools: [],
    ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
  };

  const signal = request.signal ?? AbortSignal.timeout(budgetMs);
  const completion = await client.generate({ context, payload }, signal);
  const text = completion.outputText.trim();
  return text === '' ? null : text;
}
