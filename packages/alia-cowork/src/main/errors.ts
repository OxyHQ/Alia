/** Narrow helpers for handling caught `unknown` errors without `any`. */

export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { message?: string };
    if (maybe.message) return maybe.message;
  }
  if (typeof err === 'string') return err;
  return fallback;
}

export function errorName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name;
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { name?: string };
    return maybe.name;
  }
  return undefined;
}

/** Process/exec exit code or system error code (e.g. `1`, `'ENOENT'`). */
export function errorCode(err: unknown): number | string | undefined {
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { code?: number | string };
    return maybe.code;
  }
  return undefined;
}

export function errorStack(err: unknown): string | undefined {
  if (err instanceof Error) return err.stack;
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { stack?: string };
    return maybe.stack;
  }
  return undefined;
}
