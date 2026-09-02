/**
 * One-shot text generation through Oxy inference, for product code.
 *
 * Most of Alia needs only a string back from a prompt. This helper sends that
 * request through the published `OxyInferenceClient`; Oxy authenticates Alia,
 * resolves policy and is the only component that calls Kaana.
 *
 * An empty generated answer is represented as `null`; configuration and
 * transport failures throw. Hosted callers never select a second provider path.
 *
 * ## What it does not do
 *
 * Tools, streaming, images and audio. The chat adapter carries the larger
 * surface; this helper stays intentionally narrow for one-shot derivations.
 */

import type { ResponseFormat } from '@oxyhq/contracts';

import { getOxyInferenceClient } from './oxy-inference.js';
import type { AliaInferenceSurface } from './product-seam.js';

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
   * The SDK request is aborted at this deadline. Oxy and Kaana may enforce
   * tighter upstream limits independently.
   */
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
}

export class KaanaClientUnavailableError extends Error {
  readonly code = 'KAANA_CLIENT_UNAVAILABLE' as const;

  constructor() {
    super('Kaana is required for hosted text generation but no client is configured');
    this.name = 'KaanaClientUnavailableError';
  }
}

/**
 * The generated text, or `null` when Oxy inference returned no text.
 *
 * `derived` visibility and `drop` on disconnect: every caller today is a
 * background derivation — a suggestion, a title, a summary — that nobody is
 * watching a spinner for. A user-facing turn wants different answers to both
 * questions and should build its own context rather than inherit these.
 */
export async function generateTextViaKaana(request: KaanaTextRequest): Promise<string | null> {
  const client = getOxyInferenceClient();
  if (client === null) throw new KaanaClientUnavailableError();

  const budgetMs = request.budgetMs ?? DEFAULT_BUDGET_MS;
  const completion = await client.respond({
    input: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature ?? 0.7,
    tools: [],
    ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
    labels: { 'alia.surface': request.surface, 'alia.visibility': 'derived' },
  }, {
    signal: request.signal ?? AbortSignal.timeout(budgetMs),
    ...(request.oxyUserId === undefined || request.oxyUserId === null
      ? {}
      : { delegatedUserId: request.oxyUserId }),
  });
  const text = completion.output
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text' || part.type === 'refusal')
    .map((part) => part.text)
    .join('')
    .trim();
  return text === '' ? null : text;
}
