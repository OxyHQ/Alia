import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { getAliaModel, getModelMappingsForTier } from '../../lib/gateway-client.js';
import { Conversation } from '../../models/conversation.js';
import { refundReservation } from '../../lib/credits-manager.js';
import { handleDeepResearch } from '../../lib/chat-modes/deep-research-handler.js';
import { ToolPipeline } from '../../lib/tool-pipeline.js';
import { createResponseSSEEmitter } from '../../lib/sse-emitter.js';
import { SystemPromptBuilder } from '../../lib/system-prompt-builder.js';
import { convertToAISDKMessages, type ChatMessage } from '../../lib/message-converter.js';
import { estimateMessageTokens } from '../../lib/token-counter.js';
import { wrapToolsWithTruncation, getToolResultBudget } from '../../lib/tools/result-truncation.js';
import { log } from '../../lib/logger.js';
import { recordEvent } from '../../lib/observability/index.js';
import { writeStopChunk, writeContentChunk, makeChunk } from '../../lib/streaming-helpers.js';
import { buildCompletionResponse } from '../../lib/chat/response-shapes.js';
import { SSEWriter } from '../../lib/chat/sse-writer.js';
import { buildChatRequestContext } from '../../lib/chat/request-context.js';
import type { AgentMessage } from '../../lib/chat/stream-runner.js';
import { runProviderLoop, type ChatLoopState } from '../../lib/chat/provider-loop.js';
import type { IAgent } from '../../models/agent.js';

const router = Router();

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint with streaming support
 */
export const handleChatCompletions = async (req: Request, res: Response) => {
  const requestStartTime = Date.now();
  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  const sse = new SSEWriter(res);

  // Retry-mutable state shared with the provider loop, the global-timeout timer,
  // the outer catch, and the last-resort synthetic response.
  const state: ChatLoopState = {
    resolved: null,
    aliasModelId: 'alia-v1',
    creditReservation: null,
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
        model: state.aliasModelId,
        content: "I'm sorry, the request took too long. Please try again.",
        aliaMeta: { synthetic: true, retryable: true },
      }));
    } else if (!res.writableEnded) {
      // Mid-stream timeout: send graceful finish
      writeContentChunk(res, requestId, state.aliasModelId, '\n\nI encountered a brief interruption. Please send your message again.');
      writeStopChunk(res, requestId, state.aliasModelId);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, GLOBAL_TIMEOUT_MS);

  try {
    log.v1.info('Request received');

    const ctx = await buildChatRequestContext(req, res, sse, globalTimer);
    if (!ctx) return; // response already written (validation error or gate rejection)

    const {
      body, messages, conversationId, thinkingMode, agentMode, deepResearch,
      includeUsage, isDirectUserSession, requestedModel, clientContext,
      userMemory, oxyUser, skill, linkedAgent,
    } = ctx;
    state.creditReservation = ctx.creditReservation;
    state.resolved = ctx.resolved;
    state.aliasModelId = ctx.aliasModelId;
    const { autonomyRuntime, recalledMemories } = ctx;

    // ── Deep Research Mode ──
    if (deepResearch && req.user?.id) {
      const handled = await handleDeepResearch({
        res,
        requestId,
        aliasModelId: state.aliasModelId,
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

    // Assemble all tools via the unified pipeline
    const sseEmitter = createResponseSSEEmitter(res, sse.ensureHeaders);
    const { tools: allTools, toolNameMapping } = await ToolPipeline.forUser({
      userId: req.user?.id || '',
      accessToken: req.accessToken,
      isDirectSession: isDirectUserSession,
      agentMode,
      username: oxyUser?.username,
      requestId,
      editorToolDefinitions: body.tools,
      sseEmitter,
    });

    // Agent mode: full agent escalation for linked conversations
    const agentMessages: AgentMessage[] = [];
    if (agentMode && isDirectUserSession) {

      // Check if this conversation is linked to a specific agent — enable full agent execution
      if (conversationId && req.user?.id) {
        try {
          const conv = await Conversation.findById(conversationId).select('agentId').lean();
          if (conv?.agentId) {
            const { Agent } = await import('../../models/agent.js');
            const { AgentSession } = await import('../../models/agent-session.js');
            const { enqueueAgentSession } = await import('../../lib/task-queue.js');
            const { reserveCredits: reserveAgentCredits } = await import('../../lib/credits-manager.js');

            const linkedAgent = await Agent.findById(conv.agentId).lean();
            if (linkedAgent && linkedAgent.isPublished && linkedAgent.status === 'active') {
              // Get the user's latest message as the task
              const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
              const taskText = typeof lastUserMsg?.content === 'string'
                ? lastUserMsg.content
                : Array.isArray(lastUserMsg?.content)
                  ? lastUserMsg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ')
                  : 'Execute task';

              // Reserve credits for agent execution
              const baseCredits = linkedAgent.price || 15;
              const agentReservation = await reserveAgentCredits(req.user.id, baseCredits);

              if (agentReservation) {
                // Create agent session
                const session = await AgentSession.create({
                  agentId: linkedAgent._id,
                  userId: req.user.id,
                  task: taskText.slice(0, 2000),
                  status: 'queued',
                  depth: 0,
                  creditReservation: agentReservation,
                });

                // Enqueue for async execution
                await enqueueAgentSession({
                  sessionId: session._id.toString(),
                  userId: req.user.id,
                  agentId: linkedAgent._id.toString(),
                  agentName: linkedAgent.name,
                });

                // Increment counters
                await Agent.updateOne({ _id: linkedAgent._id }, { $inc: { hireCount: 1, usageCount: 1 } });

                // Emit agent session event via SSE so frontend can subscribe
                if (body.stream) {
                  res.write(`event: alia.agent_session\ndata: ${JSON.stringify({
                    eventVersion: 1,
                    sessionId: session._id.toString(),
                    agentId: linkedAgent._id.toString(),
                    agentName: linkedAgent.name,
                  })}\n\n`);
                }

                log.v1.info({ sessionId: session._id, agentId: linkedAgent._id }, 'Agent session created from chat');
              }
            }
          }
        } catch (agentErr) {
          log.v1.warn({ err: agentErr }, 'Failed to check/create agent session from chat');
        }
      }
    }

    // Log tool schemas for debugging
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      log.v1.info({ toolCount: body.tools.length }, 'Received tools from client');
    }

    // Build complete system message via SystemPromptBuilder
    const systemMessage = await SystemPromptBuilder.build({
      aliasModelId: state.aliasModelId,
      clientContext,
      isDirectUserSession,
      userId: req.user?.id,
      accessToken: req.accessToken,
      oxyUser,
      userMemory,
      recalledMemories,
      skill: skill as { systemPrompt?: string; title?: string } | null,
      linkedAgent: linkedAgent as IAgent | null,
      agentMode,
      autonomyRuntime,
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
    const aliaModelInfo = await getAliaModel(state.aliasModelId);
    const tierMappings = aliaModelInfo ? await getModelMappingsForTier(aliaModelInfo.tier) : [];
    const modelContextTokens = (tierMappings[0]?.capabilities?.maxContextTokens as number) || 128000;
    const truncatedTools = wrapToolsWithTruncation(allTools, getToolResultBudget(modelContextTokens));
    log.v1.info({ toolNames: Object.keys(truncatedTools), toolCount: Object.keys(truncatedTools).length }, 'Tools passed to model');

    // Record agent.start for observability
    recordEvent({
      type: 'agent.start',
      timestamp: requestStartTime,
      modelId: state.aliasModelId,
      provider: state.resolved?.provider,
    });

    // Detect user language for graceful error messages
    const lastUserMsg = messages.slice().reverse().find((m: ChatMessage) => m.role === 'user');
    const lastUserText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
    const isSpanish = /[áéíóúñ¿¡]/.test(lastUserText) || /\b(hola|por favor|gracias|cómo|qué|dime|puedes)\b/i.test(lastUserText);

    // Plan previews are now AI-generated via the planPreview tool (not autonomy runtime)

    // Provider fallback retry loop — re-resolve, build config, stream/non-stream, classify + retry
    const loopResult = await runProviderLoop({
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
      thinkingMode,
      convertedMessages,
      truncatedTools,
      toolNameMapping,
      agentMessages,
      systemPromptTokens,
      requestedModel,
      isSpanish,
      autonomyRuntime,
      includeUsage,
      tierMappingsLength: tierMappings.length,
    });

    if (loopResult.status === 'completed') return; // Response fully sent

    // ── LAST-RESORT SYNTHETIC RESPONSE ──
    // All providers exhausted or time budget exceeded — respond with a friendly
    // message instead of an error so the client never sees a raw failure.
    log.v1.warn({ attempts: loopResult.attemptedProviders, model: requestedModel }, 'All providers exhausted, sending synthetic response');

    const syntheticMessage = isSpanish
      ? 'Lo siento, en este momento todos los modelos están ocupados. Por favor, intenta de nuevo en unos segundos.'
      : "I'm sorry, all models are currently busy. Please try again in a few seconds.";

    // Refund credit reservation for synthetic responses
    if (state.creditReservation) {
      refundReservation(state.creditReservation).catch((err: unknown) => log.v1.error({ err, reservationId: state.creditReservation?.userId }, 'refundReservation failed for synthetic response'));
      state.creditReservation = null;
    }

    clearTimeout(globalTimer);

    if (!sse.sent && !res.headersSent) {
      // Non-streaming: return standard JSON response
      res.json(buildCompletionResponse({
        requestId,
        model: state.aliasModelId,
        content: syntheticMessage,
        aliaMeta: { synthetic: true, retryable: true },
      }));
    } else {
      // Streaming: send synthetic message as normal SSE chunks
      sse.ensureHeaders();
      const syntheticChunk = { ...makeChunk(requestId, state.aliasModelId, [{ index: 0, delta: { content: syntheticMessage }, finish_reason: null }]), alia_meta: { synthetic: true, retryable: true } };
      res.write(`data: ${JSON.stringify(syntheticChunk)}\n\n`);
      writeStopChunk(res, requestId, state.aliasModelId);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return; // Handled — do not fall to outer catch

  } catch (e: unknown) {
    clearTimeout(globalTimer);
    log.v1.error({ err: e }, 'Request error');

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
      writeContentChunk(res, requestId, state.aliasModelId, '\n\nI encountered a brief interruption. Please send your message again and I\'ll complete my response.');
      writeStopChunk(res, requestId, state.aliasModelId);
      res.write('data: [DONE]\n\n');
      res.end();
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
