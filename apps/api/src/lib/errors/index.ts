/**
 * Alia Error System
 *
 * Standardized error codes, typed error class, and failover classification.
 * Import from this barrel module for all error-related functionality.
 */

// Error codes, types, and AliaError class
export {
  AliaError,
  AliaErrorCode,
  isAliaError,
  toSSEError,
  type AliaErrorParams,
  type FailoverReason,
} from './error-codes';

// Failover classification and conversion
export {
  classifyError,
  isTimeoutError,
  toAliaError,
  getRetryAfterHeader,
} from './failover-error';
