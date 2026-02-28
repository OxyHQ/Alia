/**
 * Error Sanitization — Provider Name Scrubbing
 *
 * CRITICAL: Users must NEVER see provider names (OpenAI, Google, Anthropic, etc.)
 * All errors are sanitized before user display. Provider details are only for logs.
 */

import { PROVIDER_NAMES as REGISTERED_PROVIDERS } from '../../internal/providers/lib/provider-names.js';
import { redactSecrets } from '../agent/secret-scanner.js';
import type { AliaError } from './error-codes.js';
import { AliaErrorCode } from './error-codes.js';

// Combine registered provider names with model-name patterns for sanitization
const PROVIDER_PATTERNS: string[] = [
  ...REGISTERED_PROVIDERS,
  'gemini', 'claude', 'gpt-', 'llama', 'whisper',
];

/**
 * Sanitize a string to remove all provider names.
 * Replaces any occurrence of a known provider name with "Alia".
 */
export function sanitizeMessage(message: string): string {
  let sanitized = message;

  for (const provider of PROVIDER_PATTERNS) {
    const regex = new RegExp(provider, 'gi');
    sanitized = sanitized.replace(regex, 'Alia');
  }

  // Remove any remaining model identifiers that might leak provider info
  sanitized = sanitized.replace(/\b(gpt-[0-9a-z-]+|claude-[0-9a-z-]+|gemini-[0-9a-z-]+)\b/gi, 'Alia model');

  return sanitized;
}

/**
 * Sanitize an entire error object for user display.
 * Strips provider names from message and error fields.
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

/**
 * Map AliaErrorCode to OpenAI-compatible error type strings.
 */
export function getOpenAIErrorType(code: string): string {
  switch (code) {
    case AliaErrorCode.RATE_LIMITED:
      return 'rate_limit_error';
    case AliaErrorCode.CREDITS_INSUFFICIENT:
    case AliaErrorCode.INVALID_REQUEST:
    case AliaErrorCode.CONTEXT_TOO_LONG:
    case AliaErrorCode.CONTENT_FILTERED:
      return 'invalid_request_error';
    case AliaErrorCode.AUTH_FAILED:
      return 'authentication_error';
    case AliaErrorCode.QUOTA_EXCEEDED:
      return 'invalid_request_error';
    case AliaErrorCode.PROVIDER_UNAVAILABLE:
    case AliaErrorCode.MODEL_UNAVAILABLE:
    case AliaErrorCode.FALLBACK_EXHAUSTED:
    case AliaErrorCode.TIMEOUT:
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
 * Format an AliaError for API response (user-facing).
 * Returns OpenAI-compatible error format.
 * NEVER includes provider information.
 */
export function formatErrorResponse(error: AliaError) {
  return {
    error: {
      message: error.userMessage,
      type: getOpenAIErrorType(error.code),
      param: null,
      code: error.code,
    }
  };
}
