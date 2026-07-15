/**
 * Writing Style Learning Hook (afterChat)
 * Passively analyzes user messages to build a writing style profile.
 * Runs after each chat completion — non-blocking, fire-and-forget.
 */

import { registerHook } from '../hook-runner.js';
import { analyzeMessage } from '../../style/style-analyzer.js';
import { getOrCreateUserMemory } from '../../memory/user-memory-service.js';
import { log } from '../../logger.js';
import {
  STYLE_LLM_REFINE_INTERVAL_MS,
  STYLE_LLM_REFINE_MIN_MESSAGES,
} from '../../../models/user-memory.js';

registerHook({
  name: 'style-learning',
  priority: 200, // Run after analytics (100)
  afterChat: async (ctx) => {
    if (!ctx.userId) return;

    // Extract user messages only, skip very short ones
    const userMessages = ctx.messages
      .filter((m: any) => m.role === 'user')
      .map((m: any) => typeof m.content === 'string' ? m.content : '')
      .filter((text: string) => text.length > 5);

    if (userMessages.length === 0) return;

    try {
      const memory = await getOrCreateUserMemory(ctx.userId);
      let profile = memory.writingStyle || null;

      // Analyze each user message in this conversation turn
      for (const msg of userMessages) {
        profile = analyzeMessage(msg, profile);
      }

      // userMessages is non-empty (guarded above), so the loop always produces a profile
      if (!profile) return;

      // Check if LLM refinement is due
      const shouldRefine = profile.messagesAnalyzed >= STYLE_LLM_REFINE_MIN_MESSAGES
        && (!profile.lastLLMRefinedAt
          || Date.now() - new Date(profile.lastLLMRefinedAt).getTime() > STYLE_LLM_REFINE_INTERVAL_MS);

      if (shouldRefine) {
        try {
          const { refineStyleWithLLM } = await import('../../style/style-refiner.js');
          const recentMessages = userMessages.slice(-30);
          const refinement = await refineStyleWithLLM(ctx.userId, profile, recentMessages);
          Object.assign(profile, refinement);
          profile.lastLLMRefinedAt = new Date();
        } catch (refineErr) {
          log.chat.error({ err: refineErr }, 'Style LLM refinement failed (non-blocking)');
        }
      }

      // Save updated profile
      memory.writingStyle = profile;
      await memory.save();
    } catch (error) {
      log.chat.error({ err: error }, 'Error in style-learning hook');
    }
  },
});
