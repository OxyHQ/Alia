/**
 * Error Handler (Standalone)
 *
 * Narrow helpers for handling `unknown` caught errors without `any`.
 */

export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { message?: string };
    if (maybe.message) return maybe.message;
  }
  if (typeof err === 'string') return err;
  return fallback;
}

export function errorCode(err: unknown): number | string | undefined {
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { code?: number | string };
    return maybe.code;
  }
  return undefined;
}

export function sanitizeError(err: unknown): string {
  return errorMessage(err);
}
