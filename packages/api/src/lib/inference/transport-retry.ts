/**
 * Retrying a connection that died before the model said anything.
 *
 * `ECONNRESET` against `https://api.oxy.so/v1/responses` is a socket the load
 * balancer or a rolling deploy closed under an idle keep-alive connection. It
 * is thrown by `fetch` (or by the first read of the body), before one token
 * existed, and the turn used to die on it.
 *
 * ## What is safe to repeat
 *
 * Only a failure BEFORE the first output event: after a delta, a tool call or a
 * tool argument reached the consumer, repeating the request would write the
 * answer twice or contradict what the person already read. From that point the
 * failure is reported, never retried.
 *
 * ## The idempotency key
 *
 * Every attempt of ONE request carries the SAME `Idempotency-Key` (the caller
 * builds the options once). The reset may have happened after Oxy received the
 * request and reserved funds; a fresh key would open a second reservation and
 * charge twice. With the same key, Oxy refuses the repeat instead.
 *
 * That refusal is `idempotency_conflict`, and on a RETRY it is evidence that
 * the earlier attempt did reach Oxy and reserved. The call then stops: it fails
 * with a typed, user-retryable error ({@link conflictAfterRetry}). It never
 * "resolves" the conflict with another key, because that is exactly the double
 * reservation the key exists to prevent. (Responses are not retained, so there
 * is nothing to replay either.) The person's own retry is a new request with a
 * new key.
 *
 * Refusals the server asserted (`OxyInferenceError`, `OxyInferenceProtocolError`)
 * are never retried here: they are answers, and `retryable` on them is Oxy's to
 * say, not a transport guess.
 */

import { OxyInferenceError, OxyInferenceProtocolError } from '@oxy.so/core/inference';

import { AliaError, AliaErrorCode } from '../errors/error-codes.js';
import { log } from '../logger.js';

/** Attempts after the first. Two keeps a deploy's connection churn survivable without a retry storm. */
export const TRANSPORT_RETRIES = 2;

/** Wait before retry n (0-based), ms. Short: the socket is dead, the service is not. */
const RETRY_DELAYS_MS = [150, 600] as const;

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** The errno-style `code` anywhere on an error's `cause` chain, if it is a transient one. */
export function transientTransportCode(error: unknown): string | null {
  if (error instanceof OxyInferenceError || error instanceof OxyInferenceProtocolError) return null;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return code;
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && /other side closed|socket hang up/i.test(message)) {
      return 'ECONNRESET';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The typed error a connection that kept failing ends the call with. */
export function transportExhausted(code: string, attempts: number, cause: unknown): AliaError {
  return new AliaError({
    code: AliaErrorCode.PROVIDER_UNAVAILABLE,
    message: `The connection to Oxy inference failed (${code}) on ${attempts} attempt${attempts === 1 ? '' : 's'} before any output`,
    retryable: true,
    reason: 'provider_unavailable',
    cause,
  });
}

/** The typed error for `idempotency_conflict` on a retry: the first attempt did reserve. */
export function conflictAfterRetry(attempts: number, cause: unknown): AliaError {
  return new AliaError({
    code: AliaErrorCode.PROVIDER_UNAVAILABLE,
    message: `Oxy inference reported idempotency_conflict on attempt ${attempts}: the earlier attempt reached Oxy before the connection reset, so the request was not repeated under another key`,
    retryable: true,
    reason: 'provider_unavailable',
    cause,
  });
}

/**
 * Run one attempt after another until one gets past the transport.
 *
 * `isOutput` says which events the consumer has acted on. Throws the attempt's
 * own error untouched when it is not a transient transport failure or output
 * already left, and {@link transportExhausted} when the retries ran out.
 */
export async function* withTransportRetry<T>(
  attempt: () => AsyncIterable<T>,
  isOutput: (event: T) => boolean,
  signal: AbortSignal,
): AsyncGenerator<T> {
  for (let tried = 1; ; tried += 1) {
    let emitted = false;
    try {
      for await (const event of attempt()) {
        if (isOutput(event)) emitted = true;
        yield event;
      }
      return;
    } catch (cause) {
      if (
        tried > 1 &&
        cause instanceof OxyInferenceError &&
        cause.code === 'idempotency_conflict'
      ) {
        throw conflictAfterRetry(tried, cause);
      }
      const code = emitted || signal.aborted ? null : transientTransportCode(cause);
      if (code === null) throw cause;
      if (tried > TRANSPORT_RETRIES) throw transportExhausted(code, tried, cause);
      log.v1.warn(
        { code, attempt: tried },
        'Oxy inference connection failed before output; retrying',
      );
      await delay(RETRY_DELAYS_MS[tried - 1] ?? 600, signal);
      if (signal.aborted) throw cause;
    }
  }
}

/** The same rule for a one-shot call, which has no output until it returns. */
export async function retryTransport<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const attempts = withTransportRetry<T>(
    async function* () {
      yield await call();
    },
    () => false,
    signal,
  );
  for await (const value of attempts) return value;
  throw new Error('unreachable: the retried call produced no value');
}
