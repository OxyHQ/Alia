/**
 * Error Sanitization — Provider Name Scrubbing
 *
 * CRITICAL: Users must NEVER see provider names (OpenAI, Google, Anthropic, etc.)
 * All errors are sanitized before user display. Provider details are only for logs.
 */

import { PROVIDER_NAMES as REGISTERED_PROVIDERS } from '../../internal/providers/lib/provider-names.js';
import { redactSecrets } from '../agent/secret-scanner.js';
import type { ClarityError } from './error-codes.js';
import { ClarityErrorCode } from './error-codes.js';

// Combine registered provider names with model-name patterns for sanitization
const PROVIDER_PATTERNS: string[] = [
  ...REGISTERED_PROVIDERS,
  'gemini', 'claude', 'gpt-', 'llama', 'whisper',
];

/**
 * Sanitize a string to remove all provider names.
 * Replaces any occurrence of a known provider name with "Clarity".
 */
export function sanitizeMessage(message: string): string {
  let sanitized = message;

  for (const provider of PROVIDER_PATTERNS) {
    const regex = new RegExp(provider, 'gi');
    sanitized = sanitized.replace(regex, 'Clarity');
  }

  // Remove any remaining model identifiers that might leak provider info
  sanitized = sanitized.replace(/\b(gpt-[0-9a-z-]+|claude-[0-9a-z-]+|gemini-[0-9a-z-]+)\b/gi, 'Clarity model');

  return sanitized;
}

/**
 * Sanitize an entire error object for user display.
 * Strips provider names from message and error fields.
 */
export function sanitizeError<T>(error: T): T {
  if (!error) return error;

  if (typeof error === 'string') {
    return sanitizeMessage(error) as T;
  }

  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof (error as Record<string, unknown>).message === 'string') {
      (error as Record<string, unknown>).message = sanitizeMessage((error as Record<string, unknown>).message as string);
    }

    if ('error' in error && typeof (error as Record<string, unknown>).error === 'string') {
      (error as Record<string, unknown>).error = sanitizeMessage((error as Record<string, unknown>).error as string);
    }
  }

  return error;
}

/**
 * Map ClarityErrorCode to OpenAI-compatible error type strings.
 */
export function getOpenAIErrorType(code: string): string {
  switch (code) {
    case ClarityErrorCode.RATE_LIMITED:
      return 'rate_limit_error';
    case ClarityErrorCode.CREDITS_INSUFFICIENT:
    case ClarityErrorCode.INVALID_REQUEST:
    case ClarityErrorCode.CONTEXT_TOO_LONG:
    case ClarityErrorCode.CONTENT_FILTERED:
      return 'invalid_request_error';
    case ClarityErrorCode.AUTH_FAILED:
      return 'authentication_error';
    case ClarityErrorCode.QUOTA_EXCEEDED:
      return 'invalid_request_error';
    case ClarityErrorCode.PROVIDER_UNAVAILABLE:
    case ClarityErrorCode.MODEL_UNAVAILABLE:
    case ClarityErrorCode.FALLBACK_EXHAUSTED:
    case ClarityErrorCode.TIMEOUT:
      return 'server_error';
    default:
      return 'server_error';
  }
}

/**
 * Sanitize a string to remove both provider names and secrets.
 * Use this for user-facing content that may contain either.
 */
export function sanitizeFull(message: string): string {
  return sanitizeMessage(redactSecrets(message).redacted);
}

/**
 * Safely extract a user-facing error message from an unknown error.
 * Wraps sanitizeMessage to strip provider names.
 */
export function getSafeErrorMessage(error: unknown, fallback: string): string {
  return sanitizeMessage(error instanceof Error ? error.message : fallback);
}

/**
 * Format an ClarityError for API response (user-facing).
 * Returns OpenAI-compatible error format.
 * NEVER includes provider information.
 */
export function formatErrorResponse(error: ClarityError) {
  return {
    error: {
      message: error.userMessage,
      type: getOpenAIErrorType(error.code),
      param: null,
      code: error.code,
    }
  };
}
