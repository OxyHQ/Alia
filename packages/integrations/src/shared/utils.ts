/**
 * Shared utilities across all messaging adapters.
 */

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
