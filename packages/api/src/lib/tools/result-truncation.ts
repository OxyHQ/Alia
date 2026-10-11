/**
 * Tool Result Truncation
 * Caps tool output to a percentage of the model's context window.
 * Truncates at paragraph/newline boundaries to keep content coherent.
 * Inspired by ZeroClaw's truncate_with_ellipsis pattern.
 */

import type { ToolSet } from 'ai';
import { log } from '../logger.js';

const DEFAULT_MAX_CHARS = 6000; // ~1500 tokens at 4 chars/token

/**
 * Truncate a tool result string to fit within a character budget.
 * @param result - Raw tool result text
 * @param maxChars - Maximum characters allowed (default 6000)
 * @returns Truncated string with marker if truncated
 */
export function truncateToolResult(result: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  if (!result || result.length <= maxChars) return result;

  const omitted = result.length - maxChars;

  // Find last newline within the budget for a clean break
  const slice = result.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf('\n');
  const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;

  log.general.info(
    { original: result.length, truncated: cutPoint, omitted },
    'Tool result truncated',
  );

  return result.slice(0, cutPoint) + `\n\n[truncated — ${omitted} chars omitted]`;
}

/**
 * Calculate max chars for tool results based on model context window.
 * Targets 30% of the context window for tool output.
 * @param contextTokens - Model's total context window in tokens
 * @returns Max characters for tool results
 */
export function getToolResultBudget(contextTokens: number): number {
  // 30% of context window, converted to chars (4 chars/token estimate)
  const budget = Math.floor(contextTokens * 0.3 * 4);
  // Clamp between 2000 and 20000 chars
  return Math.max(2000, Math.min(20000, budget));
}

/** Fields long prose usually lives in; the cheap, shape-preserving first pass. */
const CONTENT_FIELDS = new Set(['content', 'text', 'output', 'result']);
/** An array longer than this keeps its head and says how many it dropped. */
const MAX_ARRAY_ITEMS = 50;

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Every string leaf at most `leafChars`, every array at most {@link MAX_ARRAY_ITEMS}. */
function boundLeaves(value: unknown, leafChars: number): unknown {
  if (typeof value === 'string') return truncateToolResult(value, leafChars);
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundLeaves(item, leafChars));
    if (value.length > MAX_ARRAY_ITEMS)
      kept.push(`[truncated — ${value.length - MAX_ARRAY_ITEMS} more items omitted]`);
    return kept;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, boundLeaves(entry, leafChars)]),
    );
  }
  return value;
}

/**
 * Bound what a tool hands the model to `maxChars` of JSON, whatever its shape.
 *
 * This used to rewrite only TOP-LEVEL string fields named content/text/output/
 * result and pass everything else through, so an app result shaped
 * `{ data: { body } }` or a list of emails reached the model whole: four
 * `readEmail` calls in one turn overran the inference edge's input ceiling and
 * the turn failed (`context_length_exceeded`, production 2026-10-08/10).
 *
 * A top-level `card` is a UI payload stored and rendered as-is, so it is never
 * touched and never counted. Everything else is kept as it is when it fits;
 * otherwise its string leaves and arrays are shortened, and if even that is
 * too large the rest becomes one truncated JSON preview.
 */
function boundObject(obj: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const { card, ...rest } = obj;
  const withCard = (body: Record<string, unknown>) =>
    card === undefined ? body : { ...body, card };

  // First the historical, shape-preserving pass: top-level prose fields only.
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    trimmed[key] =
      typeof value === 'string' && CONTENT_FIELDS.has(key)
        ? truncateToolResult(value, maxChars)
        : value;
  }
  if (serializedLength(trimmed) <= maxChars + 64) return withCard(trimmed);

  const leafChars = Math.min(maxChars, Math.max(200, Math.floor(maxChars / 8)));
  const shortened = boundLeaves(trimmed, leafChars) as Record<string, unknown>;
  if (serializedLength(shortened) <= maxChars) return withCard(shortened);

  log.general.info(
    { original: serializedLength(rest), maxChars },
    'Tool result reduced to a preview',
  );
  return withCard({
    truncated: true,
    preview: truncateToolResult(JSON.stringify(shortened), maxChars),
  });
}

/**
 * Wrap all tools in a ToolSet with automatic result truncation.
 * Intercepts each tool's execute function to truncate string-heavy results.
 */
export function wrapToolsWithTruncation(
  tools: ToolSet,
  maxChars: number = DEFAULT_MAX_CHARS,
): ToolSet {
  const wrapped: ToolSet = {};

  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) {
      wrapped[name] = tool;
      continue;
    }

    const originalExecute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (...args: any[]) => {
        const result = await (originalExecute as (...args: unknown[]) => unknown)(...args);
        if (typeof result === 'string') {
          return truncateToolResult(result, maxChars);
        }
        if (Array.isArray(result)) {
          const bounded = boundObject({ items: result }, maxChars);
          return 'items' in bounded ? bounded.items : bounded;
        }
        if (result && typeof result === 'object') {
          return boundObject(result as Record<string, unknown>, maxChars);
        }
        return result;
      },
    };
  }

  return wrapped;
}
