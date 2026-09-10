import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { refundReservation, safeRefund } from '../../lib/credits-manager.js';
import { handleDeepResearch } from '../../lib/chat-modes/deep-research-handler.js';
import { ToolPipeline } from '../../lib/tool-pipeline.js';
import { createResponseSSEEmitter } from '../../lib/sse-emitter.js';
import { SystemPromptBuilder } from '../../lib/system-prompt-builder.js';
import { convertToAISDKMessages, type ChatMessage } from '../../lib/message-converter.js';
import { estimateMessageTokens } from '../../lib/token-counter.js';
import { wrapToolsWithTruncation, getToolResultBudget } from '../../lib/tools/result-truncation.js';
import { log } from '../../lib/logger.js';
import { recordEvent } from '../../lib/observability/index.js';
import { recordInferenceCorrelation } from '../../lib/observability/inference-correlation.js';
import { writeStopChunk, writeContentChunk, makeChunk } from '../../lib/streaming-helpers.js';
import { buildCompletionResponse } from '../../lib/chat/response-shapes.js';
import { SSEWriter } from '../../lib/chat/sse-writer.js';
import { buildChatRequestContext } from '../../lib/chat/request-context.js';
import type { AgentMessage } from '../../lib/chat/stream-runner.js';
import { runProviderLoop, type ChatLoopState } from '../../lib/chat/provider-loop.js';
import { getDefaultRoutingProfile } from '../../lib/chat-core.js';
import { AgentTurnCoordinator, type CoordinatedAgentTurn } from '../../lib/agent/agent-turn-coordinator.js';

const router = Router();

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint with streaming support
 */
export const handleChatCompletions = async (req: Request, res: Response) => {
  const requestStartTime = Date.now();
  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  const sse = new SSEWriter(res);
  let coordinatedTurn: CoordinatedAgentTurn | null = null;

  // Retry-mutable state shared with the provider loop, the global-timeout timer,
  // the outer catch, and the last-resort synthetic response.
  //
  // The seed value is READ, not merely overwritten: the global-timeout timer is
  // armed below at :44 and reports `state.routingProfileId` back to the client,
  // while `ctx.routingProfileId` only lands at :78. A request that times out during
  // resolution therefore names this value. It used to restate `'route:auto'`, so
  // that report named a model the request would not have run on — the default
  // is `route:instant`. It reads the owner now instead of restating a literal.
  const state: ChatLoopState = {
    resolved: null,
    routingProfileId: getDefaultRoutingProfile(),
    creditReservation: null,
    creditsSettled: false,
    globalTimedOut: false,
  };

  // Global request timeout guard — send a proper error BEFORE DO's gateway timeout (~120s)
  const GLOBAL_TIMEOUT_MS = 80_000;
  const globalTimer = setTimeout(() => {
    state.globalTimedOut = true;
    log.v1.error('Global request timeout after 80s');
    if (!res.headersSent) {
      // Return synthetic response instead of raw error
      res.json(buildCompletionResponse({
        requestId,
        model: state.routingProfileId,
        content: "I'm sorry, the request took too long. Please try again.",
        aliaMeta: { synthetic: true, retryable: true },
      }));
    } else if (!res.writableEnded) {
      // Mid-stream timeout: send graceful finish
      writeContentChunk(res, requestId, state.routingProfileId, '\n\nI encountered a brief interruption. Please send your message again.', { synthetic: true, retryable: true });
      writeStopChunk(res, requestId, state.routingProfileId);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, GLOBAL_TIMEOUT_MS);

  try {
    log.v1.info('Request received');

    const ctx = await buildChatRequestContext(req, res, sse, globalTimer);
    if (!ctx) return; // response already written (validation error or gate rejection)

    const {
      body, messages, conversationId, reasoningEffort, deepResearch, webSearch,
      mcpServerId,
      includeUsage, isDirectUserSession, requestedModel, clientContext, promptModelId,
      isLocalRuntime,
      userMemory, oxyUser, skills, linkedAgent,
    } = ctx;
    state.creditReservation = ctx.creditReservation;
    state.resolved = ctx.resolved;
    state.routingProfileId = ctx.routingProfileId;
    const { autonomyRuntime, recalledMemories } = ctx;
    // A linked agent is always on its agent runtime. There is no client mode
    // switch and, critically, no second paid session launched beside this turn.
    const agentRuntimeEnabled = linkedAgent != null;

    // The correlation record for this turn, before the first branch below can
    // take a request somewhere else. `kaana` is null because Alia serves this
    // in process; `kaanaCorrelationOf(event)` fills it the day workstream 8
    // wires the client in.
    recordInferenceCorrelation({
      conversationId: conversationId ?? null,
      runId: requestId,
      kaana: null,
    });

    // ── Deep Research Mode ──
    if (deepResearch && req.user?.id) {
      const handled = await handleDeepResearch({
        res,
        requestId,
        routingProfileId: state.routingProfileId,
        userId: req.user.id,
        conversationId,
        messages,
        creditReservation: state.creditReservation,
        autonomyRuntime,
        requestStartTime,
        globalTimer,
        signal: req.socket.destroyed ? AbortSignal.abort() : undefined,
      });
      if (handled) return;
    }

    if (agentRuntimeEnabled && linkedAgent && req.user?.id && isDirectUserSession) {
      const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
      const task = typeof lastUserMessage?.content === 'string'
        ? lastUserMessage.content
        : Array.isArray(lastUserMessage?.content)
          ? lastUserMessage.content
              .filter((part): part is { type: 'text'; text: string } => Boolean(
                part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string',
              ))
              .map((part) => part.text)
              .join('\n')
          : 'Continue the agent thread';
      coordinatedTurn = await AgentTurnCoordinator.begin({
        agent: linkedAgent,
        oxyUserId: req.user.id,
        conversationId,
        task,
      });
      if (body.stream) {
        sse.ensureHeaders();
        res.write(`event: alia.agent_turn\ndata: ${JSON.stringify({
          eventVersion: 1,
          turnId: coordinatedTurn.id,
          agentId: linkedAgent._id,
          conversationId: conversationId ?? null,
        })}\n\n`);
      }
    }

    // Assemble all tools via the unified pipeline
    const sseEmitter = createResponseSSEEmitter(res, sse.ensureHeaders);
    const { tools: allTools, toolNameMapping } = await ToolPipeline.forUser({
      userId: req.user?.id || '',
      accessToken: req.accessToken,
      isDirectSession: isDirectUserSession,
      // A session acts for the person holding it; an API key does not.
      actsForPerson: isDirectUserSession,
      agentMode: agentRuntimeEnabled,
      requestId,
      editorToolDefinitions: body.tools,
      sseEmitter,
      webSearch,
      mcpServerId,
      isLocalRuntime,
      toolsEnabled: true,
      agent: linkedAgent,
      skills,
      runtime: coordinatedTurn?.runtime,
    });

    const agentMessages: AgentMessage[] = [];

    // Log tool schemas for debugging
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      log.v1.info({ toolCount: body.tools.length }, 'Received tools from client');
    }

    // Build complete system message via SystemPromptBuilder
    const systemMessage = await SystemPromptBuilder.build({
      // The product's routing-profile id, or the product default for a model
      // running on the caller's own machine.
      routingProfileId: promptModelId,
      clientContext,
      isDirectUserSession,
      userId: req.user?.id,
      accessToken: req.accessToken,
      oxyUser,
      userMemory,
      recalledMemories,
      skills,
      linkedAgent,
      agentMode: agentRuntimeEnabled,
      autonomyRuntime,
      reasoningEffort,
    });


    // Replace or inject system message
    const rawMessages = [...messages];
    if (rawMessages.length === 0 || rawMessages[0].role !== 'system') {
      // No system message, add ours at the start
      rawMessages.unshift({ role: 'system', content: systemMessage });
    } else {
      // Replace client's system message with our complete one (which already includes client context)
      rawMessages[0] = { role: 'system', content: systemMessage };
    }

    // Estimate system prompt tokens (for credit calculation)
    const systemPromptTokens = estimateMessageTokens('system', systemMessage);

    // Convert OpenAI-format messages to AI SDK format (handles tool messages)
    const convertedMessages = convertToAISDKMessages(rawMessages, toolNameMapping);

    // Wrap tools with truncation to cap large results (saves tokens)
    const truncatedTools = wrapToolsWithTruncation(allTools, getToolResultBudget(128_000));
    log.v1.info({ toolNames: Object.keys(truncatedTools), toolCount: Object.keys(truncatedTools).length }, 'Tools passed to model');

    // Record agent.start for observability
    recordEvent({
      type: 'agent.start',
      timestamp: requestStartTime,
      modelId: state.routingProfileId,
      provider: state.resolved?.provider,
    });

    // Detect user language for graceful error messages
    const lastUserMsg = messages.slice().reverse().find((m: ChatMessage) => m.role === 'user');
    const lastUserText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
    const isSpanish = /[áéíóúñ¿¡]/.test(lastUserText) || /\b(hola|por favor|gracias|cómo|qué|dime|puedes)\b/i.test(lastUserText);

    // Plan previews are now AI-generated via the planPreview tool (not autonomy runtime)

    // Provider fallback retry loop — re-resolve, build config, stream/non-stream, classify + retry
    const loopResult = await runProviderLoop({
      skills,
      req,
      res,
      sse,
      requestId,
      requestStartTime,
      globalTimer,
      globalTimeoutMs: GLOBAL_TIMEOUT_MS,
      state,
      body,
      messages,
      conversationId,
      reasoningEffort,
      convertedMessages,
      truncatedTools,
      toolNameMapping,
      agentMessages,
      systemPromptTokens,
      requestedModel,
      autonomyRuntime,
      includeUsage,
      inferenceServiceToken: ctx.inferenceServiceToken,
      beforeStreamClose: coordinatedTurn
        ? async () => {
            await coordinatedTurn?.complete();
            coordinatedTurn = null;
          }
        : undefined,
    });

    if (loopResult.status === 'completed') {
      // Streaming settles before [DONE] and clears the handle. Non-streaming
      // has no client-side send race, so it is completed here as before.
      await coordinatedTurn?.complete();
      return;
    }

    // ── LAST-RESORT SYNTHETIC RESPONSE ──
    // All providers exhausted or time budget exceeded — respond with a friendly
    // message instead of an error so the client never sees a raw failure.
    const failureMeta = {
      synthetic: true,
      retryable: loopResult.error.retryable,
      error: {
        code: loopResult.error.code,
        reference: requestId,
        ...(loopResult.error.retryAfter === undefined
          ? {}
          : { retryAfter: loopResult.error.retryAfter }),
      },
    };
    log.v1.warn(
      {
        attempts: loopResult.attemptedProviders,
        model: requestedModel,
        failureCode: loopResult.error.code,
        reference: requestId,
      },
      'All providers exhausted, sending synthetic response',
    );

    const syntheticMessage = isSpanish
      ? 'Lo siento, en este momento todos los modelos están ocupados. Por favor, intenta de nuevo en unos segundos.'
      : "I'm sorry, all models are currently busy. Please try again in a few seconds.";

    // Refund credit reservation for synthetic responses
    if (state.creditReservation) {
      refundReservation(state.creditReservation).catch((err: unknown) => log.v1.error({ err, reservationId: state.creditReservation?.userId }, 'refundReservation failed for synthetic response'));
      state.creditReservation = null;
      state.creditsSettled = true;
    }

    clearTimeout(globalTimer);

    if (!sse.sent && !res.headersSent) {
      // Non-streaming: return standard JSON response
      res.json(buildCompletionResponse({
        requestId,
        model: state.routingProfileId,
        content: syntheticMessage,
        aliaMeta: failureMeta,
      }));
    } else {
      // Streaming: send synthetic message as normal SSE chunks
      sse.ensureHeaders();
      const syntheticChunk = { ...makeChunk(requestId, state.routingProfileId, [{ index: 0, delta: { content: syntheticMessage }, finish_reason: null }]), alia_meta: failureMeta };
      res.write(`data: ${JSON.stringify(syntheticChunk)}\n\n`);
      writeStopChunk(res, requestId, state.routingProfileId);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    await coordinatedTurn?.fail(new Error('All inference attempts were exhausted'));
    return; // Handled — do not fall to outer catch

  } catch (e: unknown) {
    clearTimeout(globalTimer);
    log.v1.error({ err: e }, 'Request error');
    if (coordinatedTurn) {
      try {
        await coordinatedTurn.fail(e);
      } catch (settleError) {
        log.v1.warn({ err: settleError, turnId: coordinatedTurn.id }, 'Failed to settle agent turn');
      }
    }

    // Record agent.end for observability (error path)
    recordEvent({
      type: 'agent.end',
      timestamp: Date.now(),
      durationMs: Date.now() - requestStartTime,
      error: (e as Error)?.message,
    });

    // CRITICAL: Translate error to remove provider information!
    const { toAliaError, formatErrorResponse } = await import('../../lib/errors/index.js');
    const aliaError = toAliaError(e, { provider: state.resolved?.provider, model: state.resolved?.modelId });

    if (!res.headersSent) {
      res.status(aliaError.retryable ? 503 : 500).json(formatErrorResponse(aliaError));
    } else if (!res.writableEnded) {
      // Headers already sent (streaming started) — send graceful recovery message
      writeContentChunk(res, requestId, state.routingProfileId, '\n\nI encountered a brief interruption. Please send your message again and I\'ll complete my response.', { synthetic: true, retryable: true });
      writeStopChunk(res, requestId, state.routingProfileId);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    /**
     * The one place a reservation is released.
     *
     * `reserveCredits` DEBITS on the way in, so every exit that neither charged
     * nor refunded left the person one credit poorer for an answer they never
     * got — the 80s timeout and the catch above both did, each having simply
     * forgotten. Releasing here means the next exit path cannot forget.
     */
    if (state.creditReservation && !state.creditsSettled) {
      state.creditsSettled = true;
      await safeRefund(state.creditReservation, 'request ended without charging');
    }
  }
};

router.post('/', handleChatCompletions);

/**
 * GET /v1/chat/completions
 * Health check and stats endpoint
 */
router.get('/', async (_req: Request, res: Response) => {
  res.json({
    status: '🟢 Online',
    service: 'Alia AI Agent System',
    endpoint: '/v1/chat/completions'
  });
});

export default router;
