/**
 * Alia Error Codes & Typed Error Class
 *
 * Provides a standardized error system for the Alia platform with:
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

export enum AliaErrorCode {
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
  /** User does not have enough Alia credits */
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

const DEFAULT_HTTP_STATUS: Record<AliaErrorCode, number> = {
  [AliaErrorCode.RATE_LIMITED]: 429,
  [AliaErrorCode.QUOTA_EXCEEDED]: 402,
  [AliaErrorCode.PROVIDER_UNAVAILABLE]: 503,
  [AliaErrorCode.MODEL_UNAVAILABLE]: 503,
  [AliaErrorCode.CONTEXT_TOO_LONG]: 400,
  [AliaErrorCode.FALLBACK_EXHAUSTED]: 503,
  [AliaErrorCode.CREDITS_INSUFFICIENT]: 402,
  [AliaErrorCode.AUTH_FAILED]: 401,
  [AliaErrorCode.TIMEOUT]: 408,
  [AliaErrorCode.INVALID_REQUEST]: 400,
  [AliaErrorCode.CONTENT_FILTERED]: 400,
};

// ============== DEFAULT USER MESSAGES ==============
// CRITICAL: These must NEVER contain provider names!

const DEFAULT_USER_MESSAGES: Record<AliaErrorCode, string> = {
  [AliaErrorCode.RATE_LIMITED]:
    'Too many requests. Please wait a moment and try again.',
  [AliaErrorCode.QUOTA_EXCEEDED]:
    'Service quota exceeded. Please try again later or contact support.',
  [AliaErrorCode.PROVIDER_UNAVAILABLE]:
    'Service temporarily unavailable. Please try again in a moment.',
  [AliaErrorCode.MODEL_UNAVAILABLE]:
    'The requested model is temporarily unavailable. Please try a different model.',
  [AliaErrorCode.CONTEXT_TOO_LONG]:
    'Your message is too long for this model. Please shorten it and try again.',
  [AliaErrorCode.FALLBACK_EXHAUSTED]:
    'All available models are currently busy. Please try again in a few moments.',
  [AliaErrorCode.CREDITS_INSUFFICIENT]:
    "You don't have enough credits for this request. Please add more credits.",
  [AliaErrorCode.AUTH_FAILED]:
    'Authentication failed. Please check your credentials and try again.',
  [AliaErrorCode.TIMEOUT]:
    'Request timed out. Please try again with a shorter message.',
  [AliaErrorCode.INVALID_REQUEST]:
    'Invalid request. Please check your input and try again.',
  [AliaErrorCode.CONTENT_FILTERED]:
    'Your request was filtered by our safety system. Please revise your message.',
};

// ============== ALIA ERROR CLASS ==============

export interface AliaErrorParams {
  code: AliaErrorCode;
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

export class AliaError extends Error {
  readonly code: AliaErrorCode;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  readonly reason: FailoverReason;
  readonly httpStatus: number;
  /** User-safe message (never expose provider names!) */
  readonly userMessage: string;

  constructor(params: AliaErrorParams) {
    super(params.message, { cause: params.cause });
    this.name = 'AliaError';
    this.code = params.code;
    this.retryable = params.retryable;
    this.retryAfter = params.retryAfter;
    this.reason = params.reason;
    this.httpStatus = params.httpStatus ?? DEFAULT_HTTP_STATUS[params.code] ?? 500;
    this.userMessage = params.userMessage ?? DEFAULT_USER_MESSAGES[params.code];
  }
}

// ============== TYPE GUARD ==============

export function isAliaError(err: unknown): err is AliaError {
  return err instanceof AliaError;
}

