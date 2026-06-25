/**
 * Shared utilities across all messaging adapters.
 */

/** Extract a human-readable message from an unknown caught error. */
export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { message?: string };
    if (maybe.message) return maybe.message;
  }
  if (typeof err === 'string') return err;
  return fallback;
}

/** Read a system/HTTP error code from an unknown error. */
export function errorCode(err: unknown): number | string | undefined {
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { code?: number | string };
    return maybe.code;
  }
  return undefined;
}

/** Read an HTTP status from an axios-style (`error.response.status`) or plain (`error.status`) error. */
export function errorStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { response?: { status?: number }; status?: number };
    return maybe.response?.status ?? maybe.status;
  }
  return undefined;
}

/** Read an error `name` from an unknown error. */
export function errorName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name;
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { name?: string };
    return maybe.name;
  }
  return undefined;
}

/**
 * Split long text into chunks that respect platform message length limits.
 * Prefers breaking at newlines, then spaces, then hard-cuts.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let breakAt = remaining.lastIndexOf('\n', limit);
    if (breakAt <= 0) breakAt = remaining.lastIndexOf(' ', limit);
    if (breakAt <= 0) breakAt = limit;

    chunks.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Message deduplication — prevents processing the same message twice
 * (common during reconnections). Auto-cleans after TTL.
 */
export class DedupSet {
  private seen = new Set<string>();
  private ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  /** Returns true if message was already seen (duplicate). */
  check(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    setTimeout(() => this.seen.delete(id), this.ttlMs);
    return false;
  }
}
