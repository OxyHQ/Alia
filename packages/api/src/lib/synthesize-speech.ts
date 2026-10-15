/**
 * Speech generation through the published Oxy client, on the speech models the
 * catalogue offers, in the order `rankSpeechModelIds` gives them
 * (`lib/models/auto-selection.ts`).
 *
 * This is the only place Alia calls the inference client for speech, and the
 * only place that reads that client's error type. Callers — `/v1/audio/speech`
 * and the show pipeline — see a `SpeechSynthesisError` whose `code` is Alia's
 * own and stable, whatever client answers underneath.
 */
import { OxyInferenceError, OxyInferenceProtocolError } from '@oxy.so/core/inference';
import { getSpeechModelIds } from './models/selection.js';
import { getOxyInferenceClient } from './inference/oxy-inference.js';
import { log } from './logger.js';

export interface SynthesizeSpeechOptions {
  input: string;
  voice: string;
  format: string;
  userId: string;
  speed?: number;
  signal?: AbortSignal;
}
export interface SynthesizedSpeech {
  audio: Buffer;
  format: string;
  requestId: string;
}

/**
 * Why speech could not be produced, as a code a client can act on.
 *
 * - `SPEECH_UNAVAILABLE` — nothing can speak right now: no inference client,
 *   no speech model in the catalogue, no route to one, storage not set up, or
 *   Oxy refusing Alia's own authority.
 * - `SPEECH_REJECTED` — the model refused this request: the voice, the speed,
 *   the text.
 * - `SPEECH_LIMIT_REACHED` — a rate limit, a quota, a spending limit or the
 *   balance.
 * - `SPEECH_PROVIDER_FAILED` — the upstream failed, timed out or answered
 *   something that is not audio.
 */
export type SpeechFailureCode =
  | 'SPEECH_UNAVAILABLE'
  | 'SPEECH_REJECTED'
  | 'SPEECH_LIMIT_REACHED'
  | 'SPEECH_PROVIDER_FAILED';

/** What led to the code, for the logs. Never shown to a person. */
export type SpeechFailureReason =
  | 'not_configured'
  | 'no_speech_model'
  | 'storage_unavailable'
  | 'refused'
  | 'timeout'
  | 'transport'
  | 'unexpected_format';

const FAILURE_STATUS: Readonly<Record<SpeechFailureCode, number>> = {
  SPEECH_UNAVAILABLE: 503,
  SPEECH_REJECTED: 422,
  SPEECH_LIMIT_REACHED: 429,
  SPEECH_PROVIDER_FAILED: 502,
};

/** Provider-neutral copy: no operator, deployment or upstream wording reaches a person. */
const FAILURE_MESSAGE: Readonly<Record<SpeechFailureCode, string>> = {
  SPEECH_UNAVAILABLE: 'Speech is not available right now.',
  SPEECH_REJECTED: 'This text could not be spoken.',
  SPEECH_LIMIT_REACHED: 'The speech limit has been reached. Please try again later.',
  SPEECH_PROVIDER_FAILED: 'Speech could not be generated. Please try again.',
};

type UpstreamCode = OxyInferenceError['code'];

/**
 * What every refusal Oxy can answer means for a spoken answer. Total over the
 * client's closed code set, so a code added there fails typecheck here.
 */
const FAILURE_FOR: Readonly<Record<UpstreamCode, SpeechFailureCode>> = {
  invalid_request: 'SPEECH_REJECTED',
  unsupported_modality: 'SPEECH_REJECTED',
  context_length_exceeded: 'SPEECH_REJECTED',
  request_too_large: 'SPEECH_REJECTED',
  output_limit_exceeded: 'SPEECH_REJECTED',
  policy_violation: 'SPEECH_REJECTED',
  commercial_permission_denied: 'SPEECH_REJECTED',
  upstream_content_filtered: 'SPEECH_REJECTED',
  model_not_found: 'SPEECH_UNAVAILABLE',
  no_route_available: 'SPEECH_UNAVAILABLE',
  deployment_unavailable: 'SPEECH_UNAVAILABLE',
  service_unavailable: 'SPEECH_UNAVAILABLE',
  // Oxy refusing Alia's own authority is not the person's to fix.
  authentication_failed: 'SPEECH_UNAVAILABLE',
  permission_denied: 'SPEECH_UNAVAILABLE',
  insufficient_scope: 'SPEECH_UNAVAILABLE',
  byok_credential_invalid: 'SPEECH_UNAVAILABLE',
  rate_limited: 'SPEECH_LIMIT_REACHED',
  quota_exceeded: 'SPEECH_LIMIT_REACHED',
  spending_limit_exceeded: 'SPEECH_LIMIT_REACHED',
  insufficient_balance: 'SPEECH_LIMIT_REACHED',
  provider_error: 'SPEECH_PROVIDER_FAILED',
  provider_timeout: 'SPEECH_PROVIDER_FAILED',
  provider_overloaded: 'SPEECH_PROVIDER_FAILED',
  provider_credential_invalid: 'SPEECH_PROVIDER_FAILED',
  provider_billing_refused: 'SPEECH_PROVIDER_FAILED',
  idempotency_conflict: 'SPEECH_PROVIDER_FAILED',
  cancelled: 'SPEECH_PROVIDER_FAILED',
  internal_error: 'SPEECH_PROVIDER_FAILED',
};

/**
 * Refusals the MODEL answers for, which the next speech model may not give:
 * a voice or speed it does not take, a modality it lacks, a model or route
 * that is gone. All non-retryable, so retrying the same model is pointless and
 * trying another is not.
 *
 * Deliberately absent: authentication, scope, balance, quota and spending
 * refusals (every model would refuse them alike, and a retry spends), provider
 * credential and billing refusals, content refusals (the text is the cause) and
 * everything retryable (the client's `retryAfterMs` is the answer to those).
 */
const NEXT_MODEL_ON: ReadonlySet<UpstreamCode> = new Set<UpstreamCode>([
  'invalid_request',
  'unsupported_modality',
  'model_not_found',
  'no_route_available',
  'commercial_permission_denied',
]);

/** At most this many speech models are tried for one request. */
export const MAX_SPEECH_MODEL_ATTEMPTS = 3;

/** One budget for the whole request, fallbacks included. */
const SPEECH_TIMEOUT_MS = 60_000;

export class SpeechSynthesisError extends Error {
  readonly code: SpeechFailureCode;
  readonly reason: SpeechFailureReason;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Oxy's own code and status, when Oxy refused. */
  readonly upstreamCode?: UpstreamCode;
  readonly upstreamStatus?: number;
  /** Oxy's request id for the last attempt, when it gave one. */
  readonly requestId?: string;
  /** The request field Oxy named for an `invalid_request` — a field name, never its value. */
  readonly param?: string;
  /** Every speech model tried, in order. */
  readonly models: readonly string[];

  constructor(
    code: SpeechFailureCode,
    details: {
      reason: SpeechFailureReason;
      httpStatus?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      upstreamCode?: UpstreamCode;
      upstreamStatus?: number;
      requestId?: string;
      param?: string;
      models?: readonly string[];
      cause?: unknown;
    },
  ) {
    super(
      FAILURE_MESSAGE[code],
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = 'SpeechSynthesisError';
    this.code = code;
    this.reason = details.reason;
    this.httpStatus = details.httpStatus ?? FAILURE_STATUS[code];
    this.retryable = details.retryable ?? false;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.upstreamCode !== undefined) this.upstreamCode = details.upstreamCode;
    if (details.upstreamStatus !== undefined) this.upstreamStatus = details.upstreamStatus;
    if (details.requestId) this.requestId = details.requestId;
    if (details.param !== undefined) this.param = details.param;
    this.models = details.models ?? [];
  }
}

function fromRefusal(error: OxyInferenceError, models: readonly string[]): SpeechSynthesisError {
  return new SpeechSynthesisError(FAILURE_FOR[error.code], {
    reason: 'refused',
    retryable: error.retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    upstreamCode: error.code,
    upstreamStatus: error.status,
    requestId: error.requestId,
    ...(error.param === undefined ? {} : { param: error.param }),
    models,
  });
}

export async function synthesizeSpeech(
  options: SynthesizeSpeechOptions,
): Promise<SynthesizedSpeech> {
  if (!options.userId || options.format !== 'mp3')
    throw new Error('Speech requires a user and MP3 output');
  const client = getOxyInferenceClient();
  if (client === null)
    throw new SpeechSynthesisError('SPEECH_UNAVAILABLE', { reason: 'not_configured' });
  const candidates = await getSpeechModelIds().catch((cause: unknown) => {
    throw new SpeechSynthesisError('SPEECH_UNAVAILABLE', { reason: 'no_speech_model', cause });
  });
  const models = candidates.slice(0, MAX_SPEECH_MODEL_ATTEMPTS);
  const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const tried: string[] = [];

  for (const [index, model] of models.entries()) {
    tried.push(model);
    let result: Awaited<ReturnType<typeof client.speech>>;
    try {
      result = await client.speech(
        {
          model,
          input: options.input,
          voice: options.voice,
          response_format: 'mp3',
          ...(options.speed === undefined ? {} : { speed: options.speed }),
        },
        { delegatedUserId: options.userId, signal },
      );
    } catch (error: unknown) {
      // The caller withdrew: theirs to handle, not a failure to classify.
      if (options.signal?.aborted) throw error;
      if (timeout.aborted)
        throw new SpeechSynthesisError('SPEECH_PROVIDER_FAILED', {
          reason: 'timeout',
          httpStatus: 504,
          models: [...tried],
          cause: error,
        });
      if (!(error instanceof OxyInferenceError))
        throw new SpeechSynthesisError('SPEECH_PROVIDER_FAILED', {
          reason: 'transport',
          ...(error instanceof OxyInferenceProtocolError && error.requestId
            ? { requestId: error.requestId }
            : {}),
          models: [...tried],
          cause: error,
        });
      const next = models[index + 1];
      if (next !== undefined && NEXT_MODEL_ON.has(error.code)) {
        log.speech.warn(
          {
            model,
            next,
            upstreamCode: error.code,
            upstreamStatus: error.status,
            requestId: error.requestId || undefined,
            param: error.param,
          },
          'Speech model refused the request; trying the next',
        );
        continue;
      }
      throw fromRefusal(error, [...tried]);
    }
    if (result.mediaType !== 'audio/mpeg')
      throw new SpeechSynthesisError('SPEECH_PROVIDER_FAILED', {
        reason: 'unexpected_format',
        requestId: result.requestId,
        models: [...tried],
      });
    return { audio: Buffer.from(result.audio), format: 'mp3', requestId: result.requestId };
  }
  // `getSpeechModelIds` never answers an empty list, so the loop always returns or throws.
  throw new SpeechSynthesisError('SPEECH_UNAVAILABLE', { reason: 'no_speech_model' });
}
