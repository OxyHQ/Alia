/**
 * Typed inference errors for the Relay client — epic #139 workstream 3.
 *
 * The contract owns the error VOCABULARY (`inferenceErrorSchema`, the 26 closed
 * codes, the non-retryable subset and the credential refusal). This module owns
 * the two things a consumer needs beside it:
 *
 *  1. a JS `Error` to reject with, carrying the contract body rather than
 *     restating it, so a stack trace survives;
 *  2. Alia's product policy for each code — the user-facing sentence and whether
 *     that sentence is an HTTP error or a synthetic reply.
 *
 * ## Why no `sanitizeMessage` here
 *
 * `sanitizeMessage` (`lib/errors/sanitize.ts`) rewrites every registered
 * provider name to the literal `"Alia"`. Running it on a contract error object
 * would corrupt `providerError.provider`, which the contract requires to be a
 * real provider slug (`errors.ts` `providerErrorPassthroughSchema`), and it would
 * still not be a security control. The rule this module follows instead is
 * stronger: **no upstream text ever reaches a user.** Every user-facing sentence
 * below is a constant in this file, selected by code; `error.message` is for
 * operators and is never rendered. See `docs/migration/kaana-client-gap.md` §3.8.
 */

import {
  inferenceErrorSchema,
  NON_RETRYABLE_INFERENCE_ERROR_CODES,
  type InferenceError,
  type InferenceErrorCode,
} from '@oxyhq/contracts';

const NON_RETRYABLE = new Set<InferenceErrorCode>(NON_RETRYABLE_INFERENCE_ERROR_CODES);

/**
 * The rejection value of {@link import('./kaana-client.js').RelayInferenceClient.generate}.
 *
 * A wrapper rather than the bare contract object: rejecting a promise with a
 * plain object loses the stack, and `instanceof` is how a caller tells a
 * contract failure from a programming mistake. The contract body is a field, not
 * a copy — nothing here re-declares a shape `@oxyhq/contracts` already declares.
 *
 * The `Error` message names the CODE and nothing else. `inferenceError.message`
 * may carry upstream prose, and an `Error` message is the value most likely to
 * be logged, concatenated or shown by accident.
 */
export class RelayInferenceError extends Error {
  readonly inferenceError: InferenceError;

  constructor(inferenceError: InferenceError) {
    super(`relay inference failed: ${inferenceError.code}`);
    this.name = 'RelayInferenceError';
    this.inferenceError = inferenceError;
  }

  get code(): InferenceErrorCode {
    return this.inferenceError.code;
  }

  get retryable(): boolean {
    return this.inferenceError.retryable;
  }
}

/**
 * What Alia tells a user about one error code, and how.
 *
 * `httpStatus: null` means the code has no honest HTTP answer for a waiting
 * user — the request failed for a reason that is Alia's problem rather than
 * theirs — so the `user_turn` degradation is a synthetic reply instead of an
 * error response. That is the existing shipped behaviour
 * (`routes/v1/chat-completions.ts:276-304`), expressed per code.
 */
export interface InferenceErrorPolicy {
  /** Rendered to the user. Never derived from `error.message`. */
  readonly userMessage: string;
  /** `null` ⇒ a waiting user gets a synthetic reply, not an error response. */
  readonly httpStatus: number | null;
}

const BUSY = 'All available models are currently busy. Please try again in a few moments.';

/**
 * For a platform-side failure a retry cannot clear. Separate from {@link BUSY}
 * precisely because that one promises waiting will help.
 */
const OUR_FAULT = 'Something went wrong on our side. We are looking into it.';

/**
 * Exhaustive over `InferenceErrorCode`, deliberately: a `Record` keyed by the
 * closed union means a code added to the contract fails `tsc` here instead of
 * falling into a default branch that shows a user the wrong sentence.
 */
export const INFERENCE_ERROR_POLICY: Readonly<Record<InferenceErrorCode, InferenceErrorPolicy>> = {
  invalid_request: {
    userMessage: 'That request could not be processed as written. Please check the input and try again.',
    httpStatus: 400,
  },
  authentication_failed: {
    userMessage: 'Authentication failed. Please sign in again and retry.',
    httpStatus: 401,
  },
  permission_denied: {
    userMessage: 'You do not have permission to use this model.',
    httpStatus: 403,
  },
  insufficient_scope: {
    userMessage: 'This credential is not allowed to run inference.',
    httpStatus: 403,
  },
  model_not_found: {
    userMessage: 'That model is not available.',
    httpStatus: 404,
  },
  unsupported_modality: {
    userMessage: 'That model cannot handle this kind of input.',
    httpStatus: 400,
  },
  context_length_exceeded: {
    userMessage: 'Your message is too long for this model. Please shorten it and try again.',
    httpStatus: 400,
  },
  request_too_large: {
    userMessage: 'That request is too large. Please send less at once.',
    httpStatus: 413,
  },
  output_limit_exceeded: {
    userMessage: 'The requested response is longer than this model can produce.',
    httpStatus: 400,
  },
  idempotency_conflict: {
    userMessage: 'A different request was already sent with this idempotency key.',
    httpStatus: 409,
  },
  insufficient_balance: {
    userMessage: 'There is not enough balance to run this request.',
    httpStatus: 402,
  },
  spending_limit_exceeded: {
    userMessage: 'This request would exceed the configured spending limit.',
    httpStatus: 402,
  },
  quota_exceeded: {
    userMessage: 'The usage quota for this account has been reached.',
    httpStatus: 402,
  },
  byok_credential_invalid: {
    userMessage: 'The upstream credential configured for this account was rejected.',
    httpStatus: 400,
  },
  policy_violation: {
    userMessage: 'The routing policy in force does not allow this request.',
    httpStatus: 400,
  },
  commercial_permission_denied: {
    userMessage: 'This model may not be used commercially under its current licence.',
    httpStatus: 403,
  },
  no_route_available: { userMessage: BUSY, httpStatus: null },
  upstream_content_filtered: {
    userMessage: 'Your request was filtered by our safety system. Please revise your message.',
    httpStatus: 400,
  },
  // Surfaced by `degrade` as `silent` regardless of this entry: a user who
  // cancelled does not need to be told the request was cancelled. The message is
  // still declared so the record stays exhaustive.
  cancelled: { userMessage: 'The request was cancelled.', httpStatus: 499 },
  rate_limited: {
    userMessage: 'Too many requests. Please wait a moment and try again.',
    httpStatus: null,
  },
  deployment_unavailable: { userMessage: BUSY, httpStatus: null },
  provider_error: { userMessage: BUSY, httpStatus: null },
  provider_timeout: { userMessage: BUSY, httpStatus: null },
  provider_overloaded: { userMessage: BUSY, httpStatus: null },
  /**
   * Both of these are the PLATFORM's own account with an upstream failing, and
   * both are non-retryable — so neither may say `BUSY`, which promises the wait
   * will help. `httpStatus: null` all the same: the request failed for a reason
   * that is Alia's problem rather than the caller's, and a customer told to
   * check their balance for `provider_billing_refused` would be topping up an
   * account that is not the one at fault (`@oxyhq/contracts` `errors.ts`).
   */
  provider_credential_invalid: { userMessage: OUR_FAULT, httpStatus: null },
  provider_billing_refused: { userMessage: OUR_FAULT, httpStatus: null },
  service_unavailable: { userMessage: BUSY, httpStatus: null },
  internal_error: {
    userMessage: 'Something went wrong on our side. Please try again.',
    httpStatus: null,
  },
};

/**
 * Operator-facing text, one constant per code.
 *
 * Separate from {@link INFERENCE_ERROR_POLICY}'s user sentence because the two
 * have different audiences and different rules: this one lands in
 * `inferenceError.message`, crosses `safeErrorTextSchema`, and is what a log
 * line shows. Both are constants, so neither can carry a credential.
 */
const OPERATOR_MESSAGE: Readonly<Record<InferenceErrorCode, string>> = {
  invalid_request: 'the request envelope was rejected',
  authentication_failed: 'the service credential was rejected',
  permission_denied: 'the credential may not invoke this target',
  insufficient_scope: 'the credential lacks inference:invoke',
  model_not_found: 'the requested target does not resolve',
  unsupported_modality: 'the target cannot serve this modality',
  context_length_exceeded: 'the input exceeds the target context window',
  request_too_large: 'the request payload exceeds the accepted size',
  output_limit_exceeded: 'maxOutputTokens exceeds what the target can produce',
  idempotency_conflict: 'the idempotency key is bound to a different request',
  insufficient_balance: 'the billing account balance cannot cover this request',
  spending_limit_exceeded: 'the request exceeds the account spending limit',
  quota_exceeded: 'the account usage quota is exhausted',
  byok_credential_invalid: 'the customer upstream credential was rejected',
  policy_violation: 'the routing policy refused this request',
  commercial_permission_denied: 'commercial use of the target is not permitted',
  no_route_available: 'the routing policy resolved no servable route',
  upstream_content_filtered: 'the upstream refused the content',
  cancelled: 'the caller cancelled the request',
  rate_limited: 'the request was rate limited',
  deployment_unavailable: 'no deployment of the target is currently servable',
  provider_error: 'the serving provider failed',
  provider_timeout: 'the serving provider did not answer within the budget',
  provider_overloaded: 'the serving provider is overloaded',
  provider_credential_invalid: 'the serving provider rejected the platform credential',
  provider_billing_refused: 'the serving provider declined to bill the platform account',
  service_unavailable: 'the inference service could not be reached',
  internal_error: 'the inference call failed for an unclassified reason',
};

/** Everything a caller may choose when constructing an error. */
export interface CreateInferenceErrorInput {
  readonly code: InferenceErrorCode;
  readonly requestId: string;
  /** Only applied when the code is retryable; the contract rejects it otherwise. */
  readonly retryAfterMs?: number;
  /** The offending request field, for `invalid_request`. */
  readonly param?: string;
}

/**
 * Build a contract error the client itself is the source of.
 *
 * `retryable` is DERIVED from the code rather than accepted as a parameter. The
 * contract already refuses `retryable: true` on a non-retryable code
 * (`errors.ts` `inferenceErrorSchema`'s refinement), but a caller that could
 * pass `false` on a retryable code would be able to silently disable the retry
 * path from a call site — the wrong direction is just as wrong. Deriving it
 * means the retry rule reads one closed list and nothing else can contradict it.
 *
 * Parsed through the contract schema before it is returned, so a value this
 * function produces is by construction a value a Relay consumer can parse.
 */
export function createInferenceError(input: CreateInferenceErrorInput): InferenceError {
  const retryable = !NON_RETRYABLE.has(input.code);
  return inferenceErrorSchema.parse({
    schemaVersion: 1,
    code: input.code,
    message: OPERATOR_MESSAGE[input.code],
    retryable,
    requestId: input.requestId,
    ...(retryable && input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
    ...(input.param !== undefined ? { param: input.param } : {}),
  });
}

/**
 * What a transport throws when Relay answered, and refused.
 *
 * The transport's whole job here is to hand over the decoded body untouched —
 * it does not parse it, classify it or redact it. Interpretation stays in the
 * client, because {@link parseInferenceError}'s refusal rule is a security
 * control and a control implemented once in a caller is a control every future
 * transport re-implements slightly differently.
 *
 * A transport that could not reach Relay at all throws anything else, and the
 * client reads that as unavailability.
 */
export class RelayTransportRefusal extends Error {
  readonly body: unknown;

  constructor(body: unknown) {
    super('relay refused the request');
    this.name = 'RelayTransportRefusal';
    this.body = body;
  }
}

/**
 * Read an error off the wire, or replace it with one that is safe to hand on.
 *
 * A body that fails the parse is not passed through in any form. That is the
 * point rather than a convenience: `safeErrorTextSchema` refuses text carrying a
 * credential marker, so an upstream error echoing an API key arrives here as a
 * PARSE FAILURE, and returning "the original with the message stripped" would
 * hand the caller a body whose other fields came from the same untrusted place.
 * The substitute names `internal_error` because a producer that cannot satisfy
 * its own contract is a platform fault, not a caller fault.
 */
export function parseInferenceError(value: unknown, fallbackRequestId: string): InferenceError {
  const parsed = inferenceErrorSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return createInferenceError({ code: 'internal_error', requestId: fallbackRequestId });
}
