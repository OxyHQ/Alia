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

/**
 * Recursively truncate string values in an object.
 * Only truncates fields likely to contain large content.
 */
function truncateObjectStrings(obj: any, maxChars: number): any {
  if (typeof obj === 'string') return truncateToolResult(obj, maxChars);
  if (Array.isArray(obj)) return obj.map(item => truncateObjectStrings(item, maxChars));
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Truncate known content-heavy fields
      if (typeof value === 'string' && (key === 'content' || key === 'text' || key === 'output' || key === 'result')) {
        result[key] = truncateToolResult(value, maxChars);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  return obj;
}

/**
 * Wrap all tools in a ToolSet with automatic result truncation.
 * Intercepts each tool's execute function to truncate string-heavy results.
 */
export function wrapToolsWithTruncation(tools: ToolSet, maxChars: number = DEFAULT_MAX_CHARS): ToolSet {
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
        const result = await (originalExecute as Function)(...args);
        if (typeof result === 'string') {
          return truncateToolResult(result, maxChars);
        }
        if (result && typeof result === 'object') {
          return truncateObjectStrings(result, maxChars);
        }
        return result;
      },
    };
  }

  return wrapped;
}
