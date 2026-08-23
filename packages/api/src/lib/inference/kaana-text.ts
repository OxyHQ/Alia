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

import { getKaanaClient } from './kaana.js';
import type { AliaInferenceContext, AliaInferenceSurface } from './product-seam.js';
import type { RelayRequestPayload } from './relay-request.js';

export interface KaanaTextRequest {
  /** The whole instruction. One user turn, because there is no conversation here. */
  readonly prompt: string;
  /** Which product surface is asking, for cost attribution on the receipt. */
  readonly surface: AliaInferenceSurface;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** The Oxy account this is for, or `null` for a call no user is waiting on. */
  readonly oxyUserId?: string | null;
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
    budget: { totalMs: 30_000, connectMs: 5_000, firstTokenMs: 15_000, idleStreamMs: 15_000 },
    // Nobody is watching, so a client that goes away takes the call with it
    // rather than finishing work whose result has nowhere to go.
    onDisconnect: 'abort',
  };

  const payload: RelayRequestPayload = {
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
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
  };

  const signal = request.signal ?? AbortSignal.timeout(30_000);
  const completion = await client.generate({ context, payload }, signal);
  const text = completion.outputText.trim();
  return text === '' ? null : text;
}
