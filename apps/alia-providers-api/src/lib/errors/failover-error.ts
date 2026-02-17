/**
 * Failover Error Classification
 *
 * Classifies unknown errors into FailoverReason categories to enable
 * smart fallback decisions. Adapted from OpenClaw's failover-error.ts.
 *
 * This module handles ANY error shape: Error objects, strings, plain objects,
 * null/undefined, numbers, etc. It must be robust against malformed input.
 *
 * IMPORTANT: Internal logging may reference providers, but the AliaError
 * produced by toAliaError() will NEVER expose provider names in userMessage.
 */

import {
  AliaError,
  AliaErrorCode,
  type FailoverReason,
} from './error-codes';

// ============== REGEX PATTERNS ==============

const TIMEOUT_HINT_RE = /timeout|timed out|deadline exceeded|context deadline exceeded/i;
const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;
const RATE_LIMIT_RE = /rate.?limit|too many requests/i;
const CONTENT_FILTER_RE = /content.?filter|safety|moderation|harmful/i;
const BILLING_RE = /payment required|insufficient credits|credit balance|insufficient balance|plans & billing|billing.?hard.?limit/i;
const AUTH_RE = /invalid.?api.?key|incorrect api key|invalid token|authentication|unauthorized|forbidden|access denied|expired|token has expired/i;
const OVERLOADED_RE = /overloaded|resource.?exhausted|quota exceeded/i;

/** Error codes that indicate a network-level timeout */
const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
]);

// ============== ERROR INTROSPECTION HELPERS ==============

function getStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const candidate =
    (err as { status?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  if (typeof candidate === 'number') {
    return candidate;
  }
  if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
}

function getErrorName(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return '';
  }
  return 'name' in err ? String(err.name) : '';
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const candidate = (err as { code?: unknown }).code;
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const trimmed = candidate.trim();
  return trimmed || undefined;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return String(err);
  }
  if (typeof err === 'symbol') {
    return err.description ?? '';
  }
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return '';
}

function getRetryAfterHeader(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  // Check for retry-after in response headers (common for 429 responses)
  const headers = (err as { headers?: Record<string, unknown> }).headers;
  if (headers && typeof headers === 'object') {
    const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
    if (typeof retryAfter === 'string') {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds;
      }
    }
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter;
    }
  }
  return undefined;
}

// ============== TIMEOUT DETECTION ==============

function hasTimeoutHint(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (getErrorName(err) === 'TimeoutError') {
    return true;
  }
  const message = getErrorMessage(err);
  return Boolean(message && TIMEOUT_HINT_RE.test(message));
}

/**
 * Checks if an error is a timeout error.
 * Handles TimeoutError, AbortError with timeout hints, and network timeout codes.
 */
export function isTimeoutError(err: unknown): boolean {
  if (hasTimeoutHint(err)) {
    return true;
  }
  if (!err || typeof err !== 'object') {
    return false;
  }

  // Check error code for network timeouts
  const code = getErrorCode(err);
  if (code && TIMEOUT_ERROR_CODES.has(code.toUpperCase())) {
    return true;
  }

  // AbortError with timeout-related cause or message
  if (getErrorName(err) !== 'AbortError') {
    return false;
  }
  const message = getErrorMessage(err);
  if (message && ABORT_TIMEOUT_RE.test(message)) {
    return true;
  }
  const cause = 'cause' in err ? (err as { cause?: unknown }).cause : undefined;
  const reason = 'reason' in err ? (err as { reason?: unknown }).reason : undefined;
  return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}

// ============== ERROR CLASSIFICATION ==============

/**
 * Classifies an unknown error into a FailoverReason.
 *
 * Classification priority:
 * 1. HTTP status codes (most reliable signal)
 * 2. Error codes (ETIMEDOUT, ECONNRESET, etc.)
 * 3. Error names (TimeoutError, AbortError)
 * 4. Message pattern matching (regex against error text)
 * 5. Default to 'unknown'
 */
export function classifyError(err: unknown): FailoverReason {
  // If it's already an AliaError, use its reason directly
  if (err instanceof AliaError) {
    return (err as AliaError).reason;
  }

  // --- 1. HTTP status code classification (except 400, which needs message inspection) ---
  const status = getStatusCode(err);
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  // HTTP 400 intentionally omitted — providers (especially OpenAI) return
  // billing/rate-limit errors with 400 status, so we fall through to message checks.

  // --- 2. Error code classification ---
  const code = (getErrorCode(err) ?? '').toUpperCase();
  if (TIMEOUT_ERROR_CODES.has(code)) {
    return 'timeout';
  }

  // --- 3. Timeout detection (names + message patterns) ---
  if (isTimeoutError(err)) {
    return 'timeout';
  }

  // --- 4. Message-based classification ---
  const message = getErrorMessage(err);
  if (message) {
    if (RATE_LIMIT_RE.test(message)) return 'rate_limit';
    if (OVERLOADED_RE.test(message)) return 'rate_limit';
    if (BILLING_RE.test(message)) return 'billing';
    if (AUTH_RE.test(message)) return 'auth';
    if (CONTENT_FILTER_RE.test(message)) return 'content_filter';
  }

  // --- 5. HTTP 400 fallback (no message pattern matched → genuine format error) ---
  if (status === 400) return 'format';

  // --- 6. Default ---
  return 'unknown';
}

// ============== REASON-TO-ERROR MAPPING ==============

interface ReasonMapping {
  code: AliaErrorCode;
  retryable: boolean;
  defaultRetryAfter?: number;
}

const REASON_TO_ERROR: Record<FailoverReason, ReasonMapping> = {
  timeout: {
    code: AliaErrorCode.TIMEOUT,
    retryable: true,
  },
  rate_limit: {
    code: AliaErrorCode.RATE_LIMITED,
    retryable: true,
    defaultRetryAfter: 30,
  },
  billing: {
    code: AliaErrorCode.QUOTA_EXCEEDED,
    retryable: false,
  },
  auth: {
    code: AliaErrorCode.AUTH_FAILED,
    retryable: false,
  },
  format: {
    code: AliaErrorCode.INVALID_REQUEST,
    retryable: false,
  },
  content_filter: {
    code: AliaErrorCode.CONTENT_FILTERED,
    retryable: false,
  },
  unknown: {
    code: AliaErrorCode.PROVIDER_UNAVAILABLE,
    retryable: true,
  },
};

// ============== CONVERSION ==============

/**
 * Creates an AliaError from an unknown error with optional context.
 *
 * The internal message (AliaError.message) may include provider/model info
 * for logging purposes. The userMessage will NEVER expose provider names.
 *
 * @param err - The original error (any shape)
 * @param context - Optional provider/model context for internal logging
 */
export function toAliaError(
  err: unknown,
  context?: { provider?: string; model?: string },
): AliaError {
  // If it's already an AliaError, return as-is
  if (err instanceof AliaError) {
    return err;
  }

  const reason = classifyError(err);
  const mapping = REASON_TO_ERROR[reason];
  const originalMessage = getErrorMessage(err) || String(err);
  const status = getStatusCode(err);
  const retryAfterHeader = getRetryAfterHeader(err);

  // Build internal message with provider context (for server logs only)
  const providerPrefix = context?.provider
    ? `[${context.provider}${context.model ? `/${context.model}` : ''}] `
    : '';
  const internalMessage = `${providerPrefix}${originalMessage}`;

  return new AliaError({
    code: mapping.code,
    message: internalMessage,
    // userMessage is intentionally omitted -- the AliaError constructor
    // will use the safe default from DEFAULT_USER_MESSAGES
    retryable: mapping.retryable,
    retryAfter: retryAfterHeader ?? mapping.defaultRetryAfter,
    reason,
    httpStatus: status,
    cause: err instanceof Error ? err : undefined,
  });
}
