/**
 * Error Sanitization — Provider Name Scrubbing
 *
 * CRITICAL: Users must NEVER see provider names (OpenAI, Google, Anthropic, etc.)
 * All errors are sanitized before user display. Provider details are only for logs.
 */

import { PROVIDER_NAMES as REGISTERED_PROVIDERS } from '../../internal/providers/lib/provider-names.js';
import type { AliaError } from './error-codes.js';

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
 * Format an AliaError for API response (user-facing).
 * NEVER includes provider information.
 */
export function formatErrorResponse(error: AliaError) {
  return {
    error: {
      code: error.code,
      message: error.userMessage,
      retryable: error.retryable,
      retryAfter: error.retryAfter,
    }
  };
}
