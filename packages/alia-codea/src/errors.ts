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

/** HTTP status code from an SDK/HTTP error, if present. */
export function errorStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { status?: number };
    return typeof maybe.status === 'number' ? maybe.status : undefined;
  }
  return undefined;
}
