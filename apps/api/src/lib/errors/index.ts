/**
 * Clarity Error System
 *
 * Standardized error codes, typed error class, and failover classification.
 * Import from this barrel module for all error-related functionality.
 */

// Error codes, types, and ClarityError class
export {
  ClarityError,
  ClarityErrorCode,
  isClarityError,
  toSSEError,
  type ClarityErrorParams,
  type FailoverReason,
} from './error-codes';

// Failover classification and conversion
export {
  classifyError,
  getErrorMessage,
  getStatusCode,
  isDuplicateKeyError,
  isTimeoutError,
  toClarityError,
  getRetryAfterHeader,
} from './failover-error';

// Sanitization and formatting (user-facing)
export {
  sanitizeMessage,
  sanitizeError,
  formatErrorResponse,
} from './sanitize';
