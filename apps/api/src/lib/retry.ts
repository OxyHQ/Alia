/**
 * Generic retry utility with exponential backoff and jitter.
 * Used by tools (web scraper, delegate, etc.) for transient failure recovery.
 */

import { log } from './logger.js';
import { getErrorMessage } from './errors/index.js';

export interface RetryOptions {
  maxAttempts?: number;     // Default 3
  minDelay?: number;        // Default 500ms
  maxDelay?: number;        // Default 5000ms
  shouldRetry?: (error: any) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  minDelay: 500,
  maxDelay: 5000,
  shouldRetry: () => true,
};

/**
 * Wrap an async function with exponential backoff retry.
 * Delay formula: min(maxDelay, minDelay * 2^(attempt-1)) ± 25% jitter
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions
): Promise<T> {
  const { maxAttempts, minDelay, maxDelay, shouldRetry } = { ...DEFAULT_OPTIONS, ...opts };

  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }

      // Exponential backoff with ±25% jitter
      const baseDelay = Math.min(maxDelay, minDelay * Math.pow(2, attempt - 1));
      const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1); // ±25%
      const delay = Math.max(0, Math.round(baseDelay + jitter));

      // Respect Retry-After header if present
      const retryAfter = (error as any)?.headers?.get?.('retry-after');
      const finalDelay = retryAfter ? Math.max(delay, parseInt(retryAfter, 10) * 1000) : delay;

      log.general.warn({ attempt, maxAttempts, delay: finalDelay, error: getErrorMessage(error) }, 'Retrying after transient failure');
      await new Promise(resolve => setTimeout(resolve, finalDelay));
    }
  }

  throw lastError;
}
