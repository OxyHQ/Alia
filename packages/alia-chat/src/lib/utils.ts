import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Extract a human-readable message from an unknown caught error. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { message?: string };
    if (maybe.message) return maybe.message;
  }
  if (typeof err === 'string') return err;
  return fallback;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  /**
   * Clamped to the unit table.
   *
   * `Math.floor(Math.log(bytes) / Math.log(k))` is unbounded at both ends, and
   * `sizes[i]` is `undefined` outside it — so a file of a terabyte or more read
   * "1 undefined", and any size below one byte (a fractional value, which
   * `attachment.size` can be) took `log` of a number below 1, giving `i = -1`
   * and the same undefined unit. Negative and non-finite inputs went further:
   * `Math.log` of them is `NaN`, and `sizes[NaN]` is undefined too.
   */
  const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))));
  return `${String(Math.round((bytes / Math.pow(k, i)) * 100) / 100)} ${sizes[i]}`;
}
