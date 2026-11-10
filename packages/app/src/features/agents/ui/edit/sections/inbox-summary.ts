/** The longest line the inbox shows for one item. */
const MAX_LENGTH = 120;

/** The keys an event's projection is read from, in the order they read best. */
const KNOWN_KEYS = ['subject', 'from'] as const;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH - 1)}…` : flat;
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * One line of plain text for an inbox item. The summary is what other people sent (an email's
 * subject and sender), so only string values are read, nothing is interpreted, and the result is
 * rendered as text. `null` when there is nothing readable; the caller falls back to the event type.
 */
export function summarizeInboxItem(summary: unknown): string | null {
  if (typeof summary === 'string') return clip(summary) || null;
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) return null;
  const record = summary as Record<string, unknown>;
  const known = KNOWN_KEYS.map((key) => record[key]).filter(isText);
  if (known.length > 0) return clip(known.join(' · '));
  const any = Object.values(record).find(isText);
  return any === undefined ? null : clip(any);
}
