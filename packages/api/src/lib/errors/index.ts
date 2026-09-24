/**
 * Alia Error System
 *
 * Standardized error codes, typed error class, and failover classification.
 * Import from this barrel module for all error-related functionality.
 */

// Failover classification and conversion
export {
  classifyError,
  getErrorMessage,
  getStatusCode,
  toAliaError,
} from './failover-error';

// Sanitization and formatting (user-facing)
export {
  sanitizeMessage,
  formatErrorResponse,
} from './sanitize';
