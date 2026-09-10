import { registerHook } from '../hook-runner.js';
import { getDb } from '../../../db/index.js';
import { insertChatAnalytics } from '../../../db/usage/chatAnalyticsRepository.js';
import { classifyRequestedModel } from '../../observability/requested-model.js';
import { log } from '../../logger.js';

/**
 * The per-turn usage record — epic #139 workstream 19, *"Record requested
 * model/profile, resolved revision, latency, time to first token, error class
 * and cancellation."*
 *
 * `ctx.requestedModel` is what the caller asked for and `ctx.model` is the
 * alias the provider loop settled on; both are written, both are NOT NULL, and
 * neither falls back to the other. The requested identifier is written with its
 * SHAPE beside it, because one string carries a product mode, a concrete model
 * and a legacy alias and recording it alone conflates the three —
 * `lib/observability/requested-model.ts` owns that reading. The RESOLVED
 * REVISION is `ctx.resolvedModelReference`: the `<publisher>/<model>@<revision>`
 * Kaana reported on its `start` event (or as `model` on a completed response),
 * carried through the adapter's `providerMetadata` and the turn observation.
 * Null when no answer named one — never the requested id echoed back.
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
      const requested = classifyRequestedModel(ctx.requestedModel);
      await insertChatAnalytics(getDb(), {
        oxyUserId: ctx.userId,
        conversationId: ctx.conversationId,
        requestedModelId: requested.id,
        requestedModelKind: requested.kind,
        requestedProfileId: requested.profileId,
        reasoningEffort: ctx.reasoningEffort,
        routingProfileId: ctx.modelUsed,
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
