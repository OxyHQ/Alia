/**
 * Error Classification
 *
 * Classifies errors to determine appropriate logging level and response.
 * Adapted from openclaw's pattern (~/openclaw/src/infra/unhandled-rejections.ts).
 *
 * Categories:
 * - Fatal: OOM, worker failures → must exit
 * - Transient network: ECONNRESET, ETIMEDOUT → warn and continue
 * - Abort: intentional cancellation → suppress
 * - Other: unexpected → error level, continue
 */

// Fatal errors — process is in a bad state, must exit
const FATAL_ERROR_CODES = new Set([
  'ERR_OUT_OF_MEMORY',
  'ERR_SCRIPT_EXECUTION_TIMEOUT',
  'ERR_WORKER_OUT_OF_MEMORY',
  'ERR_WORKER_UNCAUGHT_EXCEPTION',
  'ERR_WORKER_INITIALIZATION_FAILED',
]);

// Transient network errors — expected when calling external AI providers
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DNS_RESOLVE_FAILED',
  'UND_ERR_CONNECT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  if (typeof code === 'number') return String(code);
  return undefined;
}

function getErrorCause(err: unknown): unknown {
  if (!err || typeof err !== 'object') return undefined;
  return (err as { cause?: unknown }).cause;
}

function extractCodeWithCause(err: unknown): string | undefined {
  return extractErrorCode(err) ?? extractErrorCode(getErrorCause(err));
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String((err as Error).name) : '';
  if (name === 'AbortError') return true;
  const message = 'message' in err && typeof (err as Error).message === 'string'
    ? (err as Error).message : '';
  if (message === 'This operation was aborted') return true;
  return false;
}

export function isFatalError(err: unknown): boolean {
  const code = extractCodeWithCause(err);
  return code !== undefined && FATAL_ERROR_CODES.has(code);
}

export function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;

  const code = extractCodeWithCause(err);
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;

  // "fetch failed" TypeError from undici (Node's native fetch) wraps the real error
  if (err instanceof TypeError && err.message === 'fetch failed') {
    const cause = getErrorCause(err);
    if (cause) return isTransientNetworkError(cause);
    return true;
  }

  // Walk the cause chain
  const cause = getErrorCause(err);
  if (cause && cause !== err) return isTransientNetworkError(cause);

  // AggregateError may wrap multiple causes
  if (err instanceof AggregateError && err.errors?.length) {
    return err.errors.some((e) => isTransientNetworkError(e));
  }

  return false;
}
