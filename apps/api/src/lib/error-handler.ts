/**
 * Error Handler - Complete Provider Abstraction
 *
 * CRITICAL: Users must NEVER see provider names (OpenAI, Google, Anthropic, etc.)
 * All errors are translated to generic "Alia" errors for user consumption.
 * Provider details are only logged internally for debugging.
 */

import { log, sanitizeForLog } from './logger.js';

// ============== USER-FACING ERROR TYPES ==============

export enum AliaErrorCode {
  // User errors
  INVALID_REQUEST = 'INVALID_REQUEST',
  INVALID_MODEL = 'INVALID_MODEL',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS',
  AUTHENTICATION_REQUIRED = 'AUTHENTICATION_REQUIRED',

  // Service errors (never mention providers!)
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  MODEL_OVERLOADED = 'MODEL_OVERLOADED',
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  TIMEOUT = 'TIMEOUT',
  CONTEXT_LENGTH_EXCEEDED = 'CONTEXT_LENGTH_EXCEEDED',

  // Internal errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface AliaError {
  code: AliaErrorCode;
  message: string;
  userMessage: string;      // SAFE for user display - NO provider names
  internalMessage: string;  // For server logs only
  retryable: boolean;
  retryAfterSeconds?: number;
  suggestedAction?: string;
}

// ============== USER-FACING ERROR MESSAGES ==============
// These are the ONLY messages users should ever see
// Notice: ZERO mention of any provider names!

const USER_ERROR_MESSAGES: Record<AliaErrorCode, string> = {
  [AliaErrorCode.INVALID_REQUEST]: 'Invalid request. Please check your input and try again.',
  [AliaErrorCode.INVALID_MODEL]: 'The specified Alia model is not available. Please choose a different model.',
  [AliaErrorCode.RATE_LIMIT_EXCEEDED]: 'You\'ve made too many requests. Please wait a moment and try again.',
  [AliaErrorCode.INSUFFICIENT_CREDITS]: 'You don\'t have enough credits for this request. Please add more credits.',
  [AliaErrorCode.AUTHENTICATION_REQUIRED]: 'Authentication required. Please sign in to continue.',

  [AliaErrorCode.SERVICE_UNAVAILABLE]: 'Alia is temporarily unavailable. We\'re working on it! Please try again in a moment.',
  [AliaErrorCode.MODEL_OVERLOADED]: 'This Alia model is experiencing high demand. Trying backup model automatically...',
  [AliaErrorCode.PROCESSING_ERROR]: 'We encountered an error processing your request. Please try again.',
  [AliaErrorCode.TIMEOUT]: 'Request timed out. Please try a shorter message or try again.',
  [AliaErrorCode.CONTEXT_LENGTH_EXCEEDED]: 'Your message is too long. Please shorten it and try again.',

  [AliaErrorCode.INTERNAL_ERROR]: 'Something went wrong on our end. Our team has been notified.',
};

const SUGGESTED_ACTIONS: Partial<Record<AliaErrorCode, string>> = {
  [AliaErrorCode.RATE_LIMIT_EXCEEDED]: 'Wait 60 seconds before trying again',
  [AliaErrorCode.MODEL_OVERLOADED]: 'We\'re automatically trying a backup model',
  [AliaErrorCode.CONTEXT_LENGTH_EXCEEDED]: 'Try breaking your request into smaller parts',
  [AliaErrorCode.INSUFFICIENT_CREDITS]: 'Visit your account page to add credits',
};

// ============== PROVIDER ERROR MAPPING ==============
// Map provider-specific errors to generic Alia errors
// This ensures NO provider names leak to users

interface ProviderErrorPattern {
  pattern: RegExp | string;
  code: AliaErrorCode;
  retryable: boolean;
  retryAfterSeconds?: number;
}

const PROVIDER_ERROR_PATTERNS: ProviderErrorPattern[] = [
  // Provider rate limits — map to SERVICE_UNAVAILABLE (not RATE_LIMIT_EXCEEDED).
  // Alia's own rate limiter uses sendRateLimitResponse() directly and never goes
  // through translateError(), so RATE_LIMIT_EXCEEDED is reserved for user-facing limits.
  { pattern: /rate.?limit/i, code: AliaErrorCode.SERVICE_UNAVAILABLE, retryable: true, retryAfterSeconds: 30 },
  { pattern: /429/i, code: AliaErrorCode.SERVICE_UNAVAILABLE, retryable: true, retryAfterSeconds: 30 },
  { pattern: /quota.?exceeded/i, code: AliaErrorCode.SERVICE_UNAVAILABLE, retryable: true, retryAfterSeconds: 30 },
  { pattern: /too.?many.?requests/i, code: AliaErrorCode.SERVICE_UNAVAILABLE, retryable: true, retryAfterSeconds: 30 },

  // Overload (all providers)
  { pattern: /overloaded/i, code: AliaErrorCode.MODEL_OVERLOADED, retryable: true, retryAfterSeconds: 30 },
  { pattern: /capacity/i, code: AliaErrorCode.MODEL_OVERLOADED, retryable: true, retryAfterSeconds: 30 },
  { pattern: /503/i, code: AliaErrorCode.SERVICE_UNAVAILABLE, retryable: true, retryAfterSeconds: 30 },

  // Authentication
  { pattern: /401/i, code: AliaErrorCode.AUTHENTICATION_REQUIRED, retryable: false },
  { pattern: /unauthorized/i, code: AliaErrorCode.AUTHENTICATION_REQUIRED, retryable: false },
  { pattern: /invalid.?api.?key/i, code: AliaErrorCode.AUTHENTICATION_REQUIRED, retryable: false },
  { pattern: /authentication/i, code: AliaErrorCode.AUTHENTICATION_REQUIRED, retryable: false },

  // Context length
  { pattern: /context.?length/i, code: AliaErrorCode.CONTEXT_LENGTH_EXCEEDED, retryable: false },
  { pattern: /maximum.?context/i, code: AliaErrorCode.CONTEXT_LENGTH_EXCEEDED, retryable: false },
  { pattern: /token.?limit/i, code: AliaErrorCode.CONTEXT_LENGTH_EXCEEDED, retryable: false },
  { pattern: /too.?long/i, code: AliaErrorCode.CONTEXT_LENGTH_EXCEEDED, retryable: false },

  // Timeout
  { pattern: /timeout/i, code: AliaErrorCode.TIMEOUT, retryable: true, retryAfterSeconds: 5 },
  { pattern: /timed.?out/i, code: AliaErrorCode.TIMEOUT, retryable: true, retryAfterSeconds: 5 },
  { pattern: /ETIMEDOUT/i, code: AliaErrorCode.TIMEOUT, retryable: true, retryAfterSeconds: 5 },

  // Invalid request
  { pattern: /400/i, code: AliaErrorCode.INVALID_REQUEST, retryable: false },
  { pattern: /bad.?request/i, code: AliaErrorCode.INVALID_REQUEST, retryable: false },
  { pattern: /invalid/i, code: AliaErrorCode.INVALID_REQUEST, retryable: false },

  // Service unavailable
  { pattern: /500/i, code: AliaErrorCode.INTERNAL_ERROR, retryable: true, retryAfterSeconds: 10 },
  { pattern: /502/i, code: AliaErrorCode.SERVICE_UNAVAILABLE, retryable: true, retryAfterSeconds: 10 },
  { pattern: /504/i, code: AliaErrorCode.SERVICE_UNAVAILABLE, retryable: true, retryAfterSeconds: 10 },
  { pattern: /unavailable/i, code: AliaErrorCode.SERVICE_UNAVAILABLE, retryable: true, retryAfterSeconds: 30 },
];

// ============== ERROR TRANSLATION ==============

/**
 * Translate any error into a user-safe Alia error
 * STRIPS ALL PROVIDER INFORMATION
 */
export function translateError(
  error: any,
  provider?: string,
  modelId?: string
): AliaError {
  // Convert error to string for pattern matching
  const errorStr = error?.message || error?.toString() || 'Unknown error';
  const errorCode = error?.code || error?.status || '';
  const fullError = `${errorStr} ${errorCode}`.toLowerCase();

  // Match against known patterns
  for (const pattern of PROVIDER_ERROR_PATTERNS) {
    const regex = typeof pattern.pattern === 'string'
      ? new RegExp(pattern.pattern, 'i')
      : pattern.pattern;

    if (regex.test(fullError)) {
      return createAliaError(
        pattern.code,
        pattern.retryable,
        errorStr,
        provider,
        modelId,
        pattern.retryAfterSeconds
      );
    }
  }

  // Default to generic internal error
  return createAliaError(
    AliaErrorCode.INTERNAL_ERROR,
    true,
    errorStr,
    provider,
    modelId
  );
}

/**
 * Create a properly formatted Alia error
 */
function createAliaError(
  code: AliaErrorCode,
  retryable: boolean,
  internalMessage: string,
  provider?: string,
  modelId?: string,
  retryAfterSeconds?: number
): AliaError {
  // CRITICAL: User message NEVER includes provider names!
  const userMessage = USER_ERROR_MESSAGES[code];

  // Scrub API keys from internal error messages before logging (ZeroClaw pattern)
  const scrubbedMessage = sanitizeForLog(internalMessage);
  const fullInternalMessage = provider
    ? `[${provider}/${modelId}] ${scrubbedMessage}`
    : scrubbedMessage;

  // Log internally (server logs only)
  if (provider) {
    log.providers.error({ code, provider, modelId, internalMessage: scrubbedMessage }, 'Provider error translated');
  } else {
    log.general.error({ code, internalMessage: scrubbedMessage }, 'Error translated');
  }

  return {
    code,
    message: userMessage, // Same as userMessage for backwards compat
    userMessage,          // SAFE for users - NO provider names
    internalMessage: fullInternalMessage, // Scrubbed for logs
    retryable,
    retryAfterSeconds,
    suggestedAction: SUGGESTED_ACTIONS[code]
  };
}

// ============== ERROR RESPONSE HELPERS ==============

/**
 * Format error for API response (user-facing)
 * NEVER includes provider information
 */
export function formatErrorResponse(error: AliaError) {
  return {
    error: {
      code: error.code,
      message: error.userMessage, // SAFE - no provider names
      retryable: error.retryable,
      retryAfter: error.retryAfterSeconds,
      suggestedAction: error.suggestedAction
    }
  };
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: AliaError): boolean {
  return error.retryable;
}

/**
 * Get retry delay for an error
 */
export function getRetryDelay(error: AliaError): number {
  return (error.retryAfterSeconds || 5) * 1000; // Convert to milliseconds
}

// ============== PROVIDER ERROR WRAPPER ==============

/**
 * Wrap a provider call with error handling
 * Automatically translates all errors to Alia errors
 */
export async function withProviderErrorHandling<T>(
  provider: string,
  modelId: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Translate to Alia error (strips provider info)
    const aliaError = translateError(error, provider, modelId);

    // Throw with user-safe message only
    const safeError = new Error(aliaError.userMessage);
    (safeError as any).code = aliaError.code;
    (safeError as any).retryable = aliaError.retryable;
    (safeError as any).retryAfterSeconds = aliaError.retryAfterSeconds;
    (safeError as any).suggestedAction = aliaError.suggestedAction;

    throw safeError;
  }
}

// ============== SANITIZATION ==============

/**
 * Sanitize any string to remove provider names
 * Use this as a last resort safety check
 */
const PROVIDER_NAMES = [
  'openai', 'anthropic', 'google', 'gemini', 'claude',
  'groq', 'deepseek', 'mistral', 'cerebras', 'together',
  'cloudflare', 'gpt-', 'llama', 'whisper'
];

export function sanitizeMessage(message: string): string {
  let sanitized = message;

  for (const provider of PROVIDER_NAMES) {
    const regex = new RegExp(provider, 'gi');
    sanitized = sanitized.replace(regex, 'Alia');
  }

  // Remove any remaining API error codes that might leak provider info
  sanitized = sanitized.replace(/\b(gpt-[0-9a-z-]+|claude-[0-9a-z-]+|gemini-[0-9a-z-]+)\b/gi, 'Alia model');

  return sanitized;
}

/**
 * Sanitize an entire error object for user display
 */
export function sanitizeError(error: any): any {
  if (!error) return error;

  if (typeof error === 'string') {
    return sanitizeMessage(error);
  }

  if (error.message) {
    error.message = sanitizeMessage(error.message);
  }

  if (error.error && typeof error.error === 'string') {
    error.error = sanitizeMessage(error.error);
  }

  return error;
}

// ============== TESTING HELPERS ==============

/**
 * Simulate provider errors for testing
 * (Only for development/testing)
 */
export function createTestError(type: 'rate_limit' | 'overload' | 'auth' | 'timeout' | 'context'): Error {
  const errors = {
    rate_limit: new Error('OpenAI rate limit exceeded (429)'),
    overload: new Error('Anthropic service overloaded (503)'),
    auth: new Error('Invalid Google API key (401)'),
    timeout: new Error('Request to Groq timed out (ETIMEDOUT)'),
    context: new Error('Mistral context length exceeded')
  };

  return errors[type];
}

// ============== VALIDATION ==============

/**
 * Validate that an error message is safe for users (no provider names)
 * Throws if provider names are found
 */
export function validateUserSafeMessage(message: string): void {
  const lowerMessage = message.toLowerCase();

  for (const provider of PROVIDER_NAMES) {
    if (lowerMessage.includes(provider.toLowerCase())) {
      throw new Error(
        `SECURITY VIOLATION: User-facing message contains provider name "${provider}": ${message}`
      );
    }
  }
}

// Export for testing
export { PROVIDER_NAMES, USER_ERROR_MESSAGES };
