/**
 * Memory Recall Hook (beforeChat)
 * Runs before the LLM call to inject only relevant memories into context.
 * This replaces the old approach of dumping ALL memories into the system prompt.
 */

import { registerHook } from '../hook-runner.js';
import { recallRelevantMemories } from '../../memory/recall.js';

registerHook({
  name: 'memory-recall',
  priority: 10, // Run early, before other hooks
  beforeChat: async (ctx) => {
    if (!ctx.userId) return;

    // Extract the latest user message for the recall query
    const lastUserMsg = [...ctx.messages]
      .reverse()
      .find((m: any) => m.role === 'user');

    if (!lastUserMsg?.content) return;

    const messageText = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : '';

    if (!messageText) return;

    const recalled = await recallRelevantMemories(ctx.userId, messageText, 7);

    if (recalled.length === 0) return;

    return {
      metadata: {
        recalledMemories: recalled,
        memoryRecallCount: recalled.length,
      },
    };
  },
});
