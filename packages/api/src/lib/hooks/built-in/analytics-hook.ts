import { registerHook } from '../hook-runner.js';
import { getDb } from '../../../db/index.js';
import { insertChatAnalytics } from '../../../db/usage/chatAnalyticsRepository.js';
import { log } from '../../logger.js';

/**
 * `model` and `aliaModelId` are two different models and the distinction is
 * load-bearing: `ctx.modelUsed` is the PROVIDER's model id, `ctx.model` the
 * Alia-branded alias. `GET /analytics/models` resolves the alias through
 * `getAliaModel()` and skips whatever will not resolve, so writing only the
 * provider id would empty that route.
 */
registerHook({
  name: 'analytics',
  afterChat: async (ctx) => {
    if (!ctx.userId) return;
    try {
      await insertChatAnalytics(getDb(), {
        oxyUserId: ctx.userId,
        conversationId: ctx.conversationId,
        model: ctx.modelUsed,
        aliaModelId: ctx.model,
        provider: ctx.metadata.provider || 'unknown',
        promptTokens: ctx.tokenUsage.promptTokens,
        completionTokens: ctx.tokenUsage.completionTokens,
        totalTokens: ctx.tokenUsage.totalTokens,
        latencyMs: ctx.latencyMs,
        platform: ctx.platform,
        skillId: ctx.skillId,
      });
    } catch (error) {
      log.chat.error({ err: error }, 'Error saving analytics');
    }
  },
});
