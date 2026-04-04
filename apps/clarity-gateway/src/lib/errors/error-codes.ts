/**
 * Clarity Error Codes & Typed Error Class
 *
 * Provides a standardized error system for the Clarity platform with:
 * - Typed error codes for all known failure modes
 * - FailoverReason classification for smart fallback decisions
 * - Separate internal vs user-facing messages (NEVER expose provider names!)
 */

// ============== FAILOVER REASON ==============

/**
 * Classifies the root cause of a provider failure.
 * Used to decide whether/how to failover to a different provider.
 */
export type FailoverReason =
  | 'rate_limit'
  | 'billing'
  | 'auth'
  | 'timeout'
  | 'format'
  | 'content_filter'
  | 'unknown';

// ============== ERROR CODES ==============

export enum ClarityErrorCode {
  /** Provider returned 429 or rate limit message */
  RATE_LIMITED = 'RATE_LIMITED',
  /** Provider quota/billing exhausted (402, insufficient credits) */
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  /** Provider is down or unreachable */
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  /** Specific model not available (deprecated, overloaded, etc.) */
  MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE',
  /** Input exceeds model context window */
  CONTEXT_TOO_LONG = 'CONTEXT_TOO_LONG',
  /** All fallback providers have been tried and failed */
  FALLBACK_EXHAUSTED = 'FALLBACK_EXHAUSTED',
  /** User does not have enough Clarity credits */
  CREDITS_INSUFFICIENT = 'CREDITS_INSUFFICIENT',
  /** API key invalid, expired, or insufficient permissions */
  AUTH_FAILED = 'AUTH_FAILED',
  /** Request timed out (network or provider-side) */
  TIMEOUT = 'TIMEOUT',
  /** Malformed request, bad parameters, etc. */
  INVALID_REQUEST = 'INVALID_REQUEST',
  /** Content blocked by safety/moderation filter */
  CONTENT_FILTERED = 'CONTENT_FILTERED',
}

// ============== DEFAULT HTTP STATUS MAPPING ==============

const DEFAULT_HTTP_STATUS: Record<ClarityErrorCode, number> = {
  [ClarityErrorCode.RATE_LIMITED]: 429,
  [ClarityErrorCode.QUOTA_EXCEEDED]: 402,
  [ClarityErrorCode.PROVIDER_UNAVAILABLE]: 503,
  [ClarityErrorCode.MODEL_UNAVAILABLE]: 503,
  [ClarityErrorCode.CONTEXT_TOO_LONG]: 400,
  [ClarityErrorCode.FALLBACK_EXHAUSTED]: 503,
  [ClarityErrorCode.CREDITS_INSUFFICIENT]: 402,
  [ClarityErrorCode.AUTH_FAILED]: 401,
  [ClarityErrorCode.TIMEOUT]: 408,
  [ClarityErrorCode.INVALID_REQUEST]: 400,
  [ClarityErrorCode.CONTENT_FILTERED]: 400,
};

// ============== DEFAULT USER MESSAGES ==============
// CRITICAL: These must NEVER contain provider names!

const DEFAULT_USER_MESSAGES: Record<ClarityErrorCode, string> = {
  [ClarityErrorCode.RATE_LIMITED]:
    'Too many requests. Please wait a moment and try again.',
  [ClarityErrorCode.QUOTA_EXCEEDED]:
    'Service quota exceeded. Please try again later or contact support.',
  [ClarityErrorCode.PROVIDER_UNAVAILABLE]:
    'Service temporarily unavailable. Please try again in a moment.',
  [ClarityErrorCode.MODEL_UNAVAILABLE]:
    'The requested model is temporarily unavailable. Please try a different model.',
  [ClarityErrorCode.CONTEXT_TOO_LONG]:
    'Your message is too long for this model. Please shorten it and try again.',
  [ClarityErrorCode.FALLBACK_EXHAUSTED]:
    'All available models are currently busy. Please try again in a few moments.',
  [ClarityErrorCode.CREDITS_INSUFFICIENT]:
    "You don't have enough credits for this request. Please add more credits.",
  [ClarityErrorCode.AUTH_FAILED]:
    'Authentication failed. Please check your credentials and try again.',
  [ClarityErrorCode.TIMEOUT]:
    'Request timed out. Please try again with a shorter message.',
  [ClarityErrorCode.INVALID_REQUEST]:
    'Invalid request. Please check your input and try again.',
  [ClarityErrorCode.CONTENT_FILTERED]:
    'Your request was filtered by our safety system. Please revise your message.',
};

// ============== CLARITY ERROR CLASS ==============

export interface ClarityErrorParams {
  code: ClarityErrorCode;
  /** Internal message for logging -- may contain provider names */
  message: string;
  /** User-facing message -- NEVER expose provider names! */
  userMessage?: string;
  retryable: boolean;
  retryAfter?: number;
  reason: FailoverReason;
  httpStatus?: number;
  cause?: unknown;
}

export class ClarityError extends Error {
  readonly code: ClarityErrorCode;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  readonly reason: FailoverReason;
  readonly httpStatus: number;
  /** User-safe message (never expose provider names!) */
  readonly userMessage: string;

  constructor(params: ClarityErrorParams) {
    super(params.message, { cause: params.cause });
    this.name = 'ClarityError';
    this.code = params.code;
    this.retryable = params.retryable;
    this.retryAfter = params.retryAfter;
    this.reason = params.reason;
    this.httpStatus = params.httpStatus ?? DEFAULT_HTTP_STATUS[params.code] ?? 500;
    this.userMessage = params.userMessage ?? DEFAULT_USER_MESSAGES[params.code];
  }
}

// ============== TYPE GUARD ==============

export function isClarityError(err: unknown): err is ClarityError {
  return err instanceof ClarityError;
}

