/**
 * History Compaction
 * Prunes older messages when conversation history exceeds a token budget.
 * Keeps system prompt and recent messages intact; drops tool calls and
 * long assistant responses from older turns.
 */

import { estimateTokenCount } from './token-counter.js';
import { log } from './logger.js';

interface Message {
  role: string;
  content: any;
}

// Number of recent messages to always preserve (never compact the tail)
const TAIL_SIZE = 10;

/**
 * Compact conversation history to fit within a token budget.
 * Strategy:
 * 1. Always keep the last TAIL_SIZE messages intact
 * 2. For older messages: drop tool-call/tool-result messages, trim long content
 * 3. If still over budget: collapse oldest messages into a summary marker
 *
 * @param messages - Full conversation history
 * @param tokenBudget - Max tokens for the message history (excluding system prompt)
 * @returns Compacted messages array
 */
export function compactHistory(messages: Message[], tokenBudget: number): Message[] {
  if (messages.length <= TAIL_SIZE) return messages;

  // Estimate current total
  const estimateMsg = (m: Message): number => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return estimateTokenCount(content) + 4; // 4 token overhead per message
  };

  const totalTokens = messages.reduce((sum, m) => sum + estimateMsg(m), 0);
  if (totalTokens <= tokenBudget) return messages;

  log.chat.info({ totalTokens, tokenBudget, messageCount: messages.length }, 'Compacting history');

  // Split into older + tail
  const tail = messages.slice(-TAIL_SIZE);
  const older = messages.slice(0, -TAIL_SIZE);

  // Phase 1: Drop tool-related messages from older history
  const filtered = older.filter(m => m.role !== 'tool');

  // Phase 2: Trim long assistant messages in older history (keep first 200 chars)
  const trimmed = filtered.map(m => {
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 800) {
      return { ...m, content: m.content.slice(0, 200) + '... [trimmed]' };
    }
    return m;
  });

  // Check if we're within budget now
  const compactedTokens = [...trimmed, ...tail].reduce((sum, m) => sum + estimateMsg(m), 0);
  if (compactedTokens <= tokenBudget) {
    log.chat.info({ before: totalTokens, after: compactedTokens, dropped: messages.length - trimmed.length - tail.length }, 'History compacted (phase 1)');
    return [...trimmed, ...tail];
  }

  // Phase 3: Drop all older messages, insert a summary marker
  const summary: Message = {
    role: 'system',
    content: `[Earlier conversation with ${older.length} messages was summarized to save context. Recent messages follow.]`,
  };

  const finalTokens = estimateMsg(summary) + tail.reduce((sum, m) => sum + estimateMsg(m), 0);
  log.chat.info({ before: totalTokens, after: finalTokens, droppedMessages: older.length }, 'History compacted (phase 3 — summary)');

  return [summary, ...tail];
}
