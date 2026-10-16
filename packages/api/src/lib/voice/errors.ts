/**
 * Typed voice failures: the realtime counterpart of `failTurn` (ADR 0017 §3,
 * "Failures are typed"). Every failure reaches the client as
 * `error { code, retryable, reference }` followed by `session.closed`; Alia
 * never speaks a filler "sorry". The message is Alia's fixed product text per
 * code — never Kaana's or a provider's words.
 */

import type { PublicErrorCode } from '@kaana.ai/contracts';
import { KaanaConnectionError, KaanaError, KaanaProtocolError } from '@kaana.ai/sdk';
import type { VoiceServerErrorCode } from './protocol.js';

export const VOICE_ERROR_TEXT: Readonly<Record<VoiceServerErrorCode, string>> = {
  'not-authenticated': 'Sign in to Alia to start a call.',
  'credential-not-supported':
    'Voice calls are available in Alia’s own apps, with a person’s session.',
  'plan-required': 'Voice calls are part of the paid plans.',
  'credits-exhausted': "You've run out of credits for this call.",
  'agent-unavailable': 'The selected agent is unavailable.',
  'invalid-request': 'The call could not be started.',
  'resume-unavailable': 'The call could not be resumed. Start a new one.',
  'realtime-unavailable': 'Voice is not available right now. Try again in a moment.',
  'realtime-limited': 'Voice has reached its limit for now. Try again later.',
  'realtime-rejected': 'The call could not be started with these settings.',
  'realtime-failed': 'The call failed. Try again.',
};

/** A failure the session ends with. */
export class VoiceFailure extends Error {
  readonly code: VoiceServerErrorCode;
  readonly retryable: boolean;
  constructor(code: VoiceServerErrorCode, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(
      VOICE_ERROR_TEXT[code],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'VoiceFailure';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

const LIMITED: ReadonlySet<PublicErrorCode> = new Set([
  'rate_limited',
  'insufficient_balance',
  'spending_limit_exceeded',
  'quota_exceeded',
]);

const UNAVAILABLE: ReadonlySet<PublicErrorCode> = new Set([
  'no_route_available',
  'service_unavailable',
  'model_not_found',
  // Alia's own credential was refused: nothing the person can change.
  'authentication_failed',
]);

const FAILED: ReadonlySet<PublicErrorCode> = new Set([
  'provider_error',
  'provider_timeout',
  'provider_overloaded',
  'internal_error',
  'cancelled',
]);

/**
 * The `VoiceServerErrorCode` for anything Kaana's SDK threw (ADR 0017 §3
 * table): unavailable or no model → `realtime-unavailable`; rate or billing →
 * `realtime-limited`; invalid or permission → `realtime-rejected`; provider
 * failure, a lost connection or a contract violation → `realtime-failed`.
 * Anything that is not a Kaana failure is `realtime-failed` too.
 */
export function voiceFailureFromKaana(error: unknown): VoiceFailure {
  if (error instanceof VoiceFailure) return error;
  if (!(error instanceof KaanaError))
    return new VoiceFailure('realtime-failed', { retryable: true, cause: error });
  const { code, retryable } = error;
  if (UNAVAILABLE.has(code))
    return new VoiceFailure('realtime-unavailable', { retryable, cause: error });
  if (LIMITED.has(code)) return new VoiceFailure('realtime-limited', { retryable, cause: error });
  if (FAILED.has(code)) return new VoiceFailure('realtime-failed', { retryable, cause: error });
  return new VoiceFailure('realtime-rejected', { retryable: false, cause: error });
}

/**
 * Whether the MODEL itself refused an open, before any audio flowed — the only
 * case the open moves to the next candidate (ADR 0017 §2). Authentication,
 * credit and rate refusals fail at once, as speech does.
 */
export function isModelRefusal(error: unknown): boolean {
  if (!(error instanceof KaanaError) || error.afterOutput) return false;
  if (
    error.code === 'model_not_found' ||
    error.code === 'unsupported_modality' ||
    error.code === 'no_route_available'
  )
    return true;
  return (
    error.code === 'invalid_request' &&
    typeof error.param === 'string' &&
    /voice|config/i.test(error.param)
  );
}

/** Why Kaana or the connection refused a call, as the log carries it. */
export type VoiceFailureUpstream =
  | {
      readonly kind: 'kaana';
      readonly code: PublicErrorCode;
      readonly param: string | null;
      readonly requestId: string | null;
      readonly status: number | null;
    }
  | { readonly kind: 'connection' | 'protocol' };

/**
 * What an operator needs to read a failure from the log alone: Kaana's code,
 * param and request id when Kaana refused, the kind of a transport failure
 * otherwise, nothing for a failure Alia decided itself. Never what the person
 * hears (that is {@link VOICE_ERROR_TEXT}).
 */
export function upstreamOfFailure(failure: VoiceFailure): VoiceFailureUpstream | null {
  const upstream = failure.cause;
  if (upstream instanceof KaanaConnectionError) return { kind: 'connection' };
  if (upstream instanceof KaanaProtocolError) return { kind: 'protocol' };
  if (!(upstream instanceof KaanaError)) return null;
  return {
    kind: 'kaana',
    code: upstream.code,
    param: upstream.param ?? null,
    requestId: upstream.requestId,
    status: upstream.status,
  };
}
