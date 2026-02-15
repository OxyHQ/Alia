/**
 * Tool Result Truncation
 * Caps tool output to a percentage of the model's context window.
 * Truncates at paragraph/newline boundaries to keep content coherent.
 */

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

  log.general.info({ original: result.length, truncated: cutPoint, omitted }, 'Tool result truncated');

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
