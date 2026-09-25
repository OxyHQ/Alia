import { registerHook } from '../hook-runner.js';
import { getDb } from '../../../db/index.js';
import { insertChatAnalytics } from '../../../db/usage/chatAnalyticsRepository.js';
import { log } from '../../logger.js';

/**
 * The per-turn usage record — epic #139 workstream 19, *"Record requested
 * model/profile, resolved revision, latency, time to first token, error class
 * and cancellation."*
 *
 * `ctx.requestedModel` is what the caller asked for and `ctx.modelUsed` is the
 * `publisher/model` the turn ran on (ADR 0012); both are written and neither
 * falls back to the other. `model` is also what ranks featured models and
 * picks each person's default (`lib/models/selection.ts`). The RESOLVED
 * REVISION is `ctx.resolvedModelReference`: the `<publisher>/<model>@<revision>`
 * Kaana reported, or null when no answer named one.
 *
 * The row is written for a FAILED turn as well as a successful one — that is
 * what makes `errorClass` a column with values in it rather than one that is
 * null on every row.
 */
registerHook({
  name: 'analytics',
  afterChat: async (ctx) => {
    if (!ctx.userId) return;
    try {
      await insertChatAnalytics(getDb(), {
        oxyUserId: ctx.userId,
        conversationId: ctx.conversationId,
        requestedModelId: ctx.requestedModel,
        reasoningEffort: ctx.reasoningEffort,
        model: ctx.modelUsed,
        promptTokens: ctx.tokenUsage.promptTokens,
        completionTokens: ctx.tokenUsage.completionTokens,
        totalTokens: ctx.tokenUsage.totalTokens,
        latencyMs: ctx.latencyMs,
        timeToFirstTokenMs: ctx.timeToFirstTokenMs,
        errorClass: ctx.errorClass,
        cancelled: ctx.cancelled,
        resolvedModelReference: ctx.resolvedModelReference,
        platform: ctx.platform,
        skillNames: ctx.skillNames ?? [],
      });
    } catch (error) {
      log.chat.error({ err: error }, 'Error saving analytics');
    }
  },
});
