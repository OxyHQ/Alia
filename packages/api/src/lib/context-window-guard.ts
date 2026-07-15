/**
 * Context Window Guard
 * Pre-flight check that estimates total token usage and blocks requests
 * that would exceed the model's context window.
 */

import { estimateMessageTokens } from './token-counter.js';
import { log } from './logger.js';

export interface ContextCheckResult {
  fits: boolean;
  estimatedTokens: number;
  contextLimit: number;
  usage: number; // Percentage 0-100
  action: 'ok' | 'warn' | 'block';
}

/**
 * Check if messages + system prompt fit within the model's context window.
 * - Block at 90% (would likely fail anyway)
 * - Warn at 75% (log warning, still proceed)
 */
export function checkContextFit(
  messages: Array<{ role: string; content: any }>,
  systemPrompt: string,
  contextLimit: number
): ContextCheckResult {
  // Estimate system prompt tokens
  let totalTokens = estimateMessageTokens('system', systemPrompt);

  // Estimate each message
  for (const msg of messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    totalTokens += estimateMessageTokens(msg.role, content);
  }

  const usage = Math.round((totalTokens / contextLimit) * 100);

  if (usage >= 90) {
    log.chat.warn({ estimatedTokens: totalTokens, contextLimit, usage }, 'Context window BLOCKED — would exceed 90%');
    return { fits: false, estimatedTokens: totalTokens, contextLimit, usage, action: 'block' };
  }

  if (usage >= 75) {
    log.chat.warn({ estimatedTokens: totalTokens, contextLimit, usage }, 'Context window WARNING — exceeds 75%');
    return { fits: true, estimatedTokens: totalTokens, contextLimit, usage, action: 'warn' };
  }

  return { fits: true, estimatedTokens: totalTokens, contextLimit, usage, action: 'ok' };
}
