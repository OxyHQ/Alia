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
import { BILLING_RE, AUTH_RE } from '../constants.js';

// ============== REGEX PATTERNS ==============

const TIMEOUT_HINT_RE = /timeout|timed out|deadline exceeded|context deadline exceeded/i;
const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;
const RATE_LIMIT_RE = /rate.?limit|too many requests/i;
const CONTENT_FILTER_RE = /content.?filter|safety|moderation|harmful/i;
const OVERLOADED_RE = /overloaded|resource.?exhausted|quota exceeded/i;
const TOOL_CAPABILITY_RE = /tool.?use.?failed|failed to call a function|does not support tools|tool.?call.*not supported/i;
const GEO_RESTRICTION_RE = /location.{0,20}not supported|not available in your (country|region)|geo.?restrict|region.?not.?supported|service.?not.?available.{0,30}(country|region|location)/i;

/** Error codes that indicate a network-level timeout */
const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
]);

// ============== ERROR INTROSPECTION HELPERS ==============

export function getStatusCode(err: unknown): number | undefined {
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

export function getErrorMessage(err: unknown): string {
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

/** Check if an error is a MongoDB duplicate key error (code 11000). */
export function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return 'code' in err && (err as { code: unknown }).code === 11000;
}

export function getRetryAfterHeader(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const headers = (err as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') return undefined;

  // Support both Fetch API Headers instances (.get()) and plain objects
  let rawValue: unknown;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    rawValue = (headers as { get: (key: string) => string | null }).get('retry-after');
  } else {
    rawValue = (headers as Record<string, unknown>)['retry-after']
            ?? (headers as Record<string, unknown>)['Retry-After'];
  }

  if (typeof rawValue === 'string') {
    const seconds = Number(rawValue);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return rawValue;
  }
  return undefined;
}

// ============== PROVIDER-SPECIFIC DATA EXTRACTION ==============

/**
 * Structured data extracted from provider-specific error responses.
 * The Vercel AI SDK parses each provider's error JSON into APICallError.data.
 */
interface ProviderErrorInfo {
  /** Google: error.status (e.g. "FAILED_PRECONDITION", "RESOURCE_EXHAUSTED") */
  googleStatus?: string;
  /** OpenAI/compatible: error.type (e.g. "invalid_request_error", "server_error") */
  openaiType?: string;
  /** OpenAI/compatible: error.code (e.g. "billing_hard_limit_reached") */
  openaiCode?: string;
  /** Anthropic: error.type (e.g. "overloaded_error", "rate_limit_error") */
  anthropicType?: string;
}

/**
 * Extract structured error info from the AI SDK's APICallError.data field.
 * Each provider returns errors in a different JSON format; this function
 * reads all possible fields and lets the classifier decide relevance.
 */
function getProviderErrorData(err: unknown): ProviderErrorInfo {
  if (!err || typeof err !== 'object') return {};

  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return {};

  const result: ProviderErrorInfo = {};

  // Google format: { error: { code, message, status } }
  // OpenAI format: { error: { message, type, param, code } }
  const errorObj = (data as { error?: unknown }).error;
  if (errorObj && typeof errorObj === 'object') {
    const e = errorObj as Record<string, unknown>;

    // Google's "status" field (FAILED_PRECONDITION, RESOURCE_EXHAUSTED, etc.)
    if (typeof e.status === 'string' && /^[A-Z_]+$/.test(e.status)) {
      result.googleStatus = e.status;
    }

    // OpenAI's "type" field (invalid_request_error, rate_limit_error, etc.)
    if (typeof e.type === 'string' && e.type.includes('_')) {
      result.openaiType = e.type;
    }

    // OpenAI's "code" field (billing_hard_limit_reached, etc.)
    if (typeof e.code === 'string') {
      result.openaiCode = e.code;
    }
  }

  // Anthropic format: { type: "error", error: { type, message } }
  const topType = (data as { type?: unknown }).type;
  if (topType === 'error' && errorObj && typeof errorObj === 'object') {
    const e = errorObj as Record<string, unknown>;
    if (typeof e.type === 'string') {
      result.anthropicType = e.type;
    }
  }

  return result;
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
 * 1. HTTP status codes (unambiguous codes only)
 * 2. Error codes (ETIMEDOUT, ECONNRESET, etc.)
 * 3. Timeout detection (names + message patterns)
 * 4. Provider-specific structured data (APICallError.data)
 * 5. Message pattern matching (regex against error text)
 * 6. HTTP 400 fallback (only after all inspections fail)
 * 7. HTTP 5xx fallback
 * 8. Default to 'unknown'
 */
export function classifyError(err: unknown): FailoverReason {
  // If it's already an AliaError, use its reason directly
  if (err instanceof AliaError) {
    return err.reason;
  }

  // --- 1. HTTP status code classification (unambiguous codes only) ---
  const status = getStatusCode(err);
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 529) return 'rate_limit'; // Anthropic overloaded
  // HTTP 400 intentionally omitted — providers (especially OpenAI) return
  // billing/rate-limit errors with 400 status, so we fall through to data+message checks.

  // --- 2. Error code classification ---
  const code = (getErrorCode(err) ?? '').toUpperCase();
  if (TIMEOUT_ERROR_CODES.has(code)) {
    return 'timeout';
  }
  if (code === 'TOOL_USE_FAILED') {
    return 'format';
  }

  // --- 3. Timeout detection (names + message patterns) ---
  if (isTimeoutError(err)) {
    return 'timeout';
  }

  // --- 4. Provider-specific structured data classification ---
  const providerData = getProviderErrorData(err);

  // Google: FAILED_PRECONDITION → provider-specific (geo-restriction, unsupported feature)
  if (providerData.googleStatus === 'FAILED_PRECONDITION') {
    return 'provider_unavailable';
  }
  // Google: RESOURCE_EXHAUSTED → rate limit (Google's 429 equivalent)
  if (providerData.googleStatus === 'RESOURCE_EXHAUSTED') {
    return 'rate_limit';
  }
  // Google: UNAVAILABLE → provider down
  if (providerData.googleStatus === 'UNAVAILABLE') {
    return 'provider_unavailable';
  }
  // Google: PERMISSION_DENIED → check message for geo vs auth
  if (providerData.googleStatus === 'PERMISSION_DENIED') {
    const msg = getErrorMessage(err);
    if (msg && GEO_RESTRICTION_RE.test(msg)) {
      return 'provider_unavailable';
    }
    return 'auth';
  }

  // OpenAI: structured error types
  if (providerData.openaiType === 'rate_limit_error') return 'rate_limit';
  if (providerData.openaiType === 'authentication_error') return 'auth';
  if (providerData.openaiType === 'server_error') return 'provider_unavailable';
  // OpenAI: billing codes surfaced as 400
  if (providerData.openaiCode === 'billing_hard_limit_reached' ||
      providerData.openaiCode === 'insufficient_quota') {
    return 'billing';
  }

  // Anthropic: structured error types
  if (providerData.anthropicType === 'rate_limit_error') return 'rate_limit';
  if (providerData.anthropicType === 'authentication_error') return 'auth';
  if (providerData.anthropicType === 'overloaded_error') return 'rate_limit';

  // --- 5. Message-based classification ---
  const message = getErrorMessage(err);
  if (message) {
    if (RATE_LIMIT_RE.test(message)) return 'rate_limit';
    if (OVERLOADED_RE.test(message)) return 'rate_limit';
    if (BILLING_RE.test(message)) return 'billing';
    if (AUTH_RE.test(message)) return 'auth';
    if (GEO_RESTRICTION_RE.test(message)) return 'provider_unavailable';
    if (TOOL_CAPABILITY_RE.test(message)) return 'format';
    if (CONTENT_FILTER_RE.test(message)) return 'content_filter';
  }

  // --- 6. HTTP 400 fallback (no message or data pattern matched → genuine format error) ---
  if (status === 400) return 'format';

  // --- 7. HTTP 5xx → provider unavailable (retryable on different provider) ---
  if (status !== undefined && status >= 500) return 'provider_unavailable';

  // --- 8. Default ---
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
  provider_unavailable: {
    code: AliaErrorCode.PROVIDER_UNAVAILABLE,
    retryable: true,
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
