/**
 * Error Handler (Standalone)
 */

export function sanitizeError(err: any): string {
  return err?.message || 'Unknown error';
}
