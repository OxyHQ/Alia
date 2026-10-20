/**
 * Writing Style Learning Hook (afterChat)
 * Passively analyzes user messages to build a writing style profile.
 * Runs after each chat completion — non-blocking, fire-and-forget.
 */

import { registerHook } from '../hook-runner.js';
import { analyzeMessage } from '../../style/style-analyzer.js';
import { getOrCreateUserMemory } from '../../memory/user-memory-service.js';
import { getDb } from '../../../db/index.js';
import { setWritingStyle } from '../../../db/memory/userMemoryRepository.js';
import { log } from '../../logger.js';
import {
  STYLE_LLM_REFINE_INTERVAL_MS,
  STYLE_LLM_REFINE_MIN_MESSAGES,
} from '../../../domain/writing-style.js';

registerHook({
  name: 'style-learning',
  priority: 200, // Run after analytics (100)
  afterChat: async (ctx) => {
    if (!ctx.userId) return;
    // Alia's profile of the person comes from Alia's turns; a failed turn has
    // nothing to learn from either.
    if (ctx.agentTurn || ctx.errorClass) return;

    // Only the message this turn added. The history is the same text the
    // earlier turns already analysed, and counting it again would weight every
    // old message once per turn that followed it.
    const latest = [...ctx.messages].reverse().find((m: any) => m.role === 'user');
    const text = typeof latest?.content === 'string' ? latest.content : '';
    const userMessages = text.length > 5 ? [text] : [];

    if (userMessages.length === 0) return;

    try {
      const memory = await getOrCreateUserMemory(ctx.userId);
      let profile = memory.writingStyle || null;

      // Analyze this turn's message
      for (const msg of userMessages) {
        profile = analyzeMessage(msg, profile);
      }

      // userMessages is non-empty (guarded above), so the loop always produces a profile
      if (!profile) return;

      // Check if LLM refinement is due
      const shouldRefine =
        profile.messagesAnalyzed >= STYLE_LLM_REFINE_MIN_MESSAGES &&
        (!profile.lastLLMRefinedAt ||
          Date.now() - new Date(profile.lastLLMRefinedAt).getTime() > STYLE_LLM_REFINE_INTERVAL_MS);

      if (shouldRefine) {
        try {
          const { refineStyleWithLLM } = await import('../../style/style-refiner.js');
          // The refinement reads a sample of the person's recent writing, not only today's line.
          const recentMessages = ctx.messages
            .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
            .map((m: any) => m.content as string)
            .filter((message: string) => message.length > 5)
            .slice(-30);
          const refinement = await refineStyleWithLLM(ctx.userId, profile, recentMessages);
          Object.assign(profile, refinement);
          profile.lastLLMRefinedAt = new Date();
        } catch (refineErr) {
          log.chat.error({ err: refineErr }, 'Style LLM refinement failed (non-blocking)');
        }
      }

      // Save updated profile
      await setWritingStyle(getDb(), memory._id, profile);
    } catch (error) {
      log.chat.error({ err: error }, 'Error in style-learning hook');
    }
  },
});
