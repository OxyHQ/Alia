import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { streamText, generateText, stepCountIs } from 'ai';
import { resolveModel, getAIModel, reportModelUsage } from '../../lib/chat-core.js';
import { getAliaModel, getModelMappingsForTier } from '../../lib/gateway-client.js';
import { Conversation } from '../../models/conversation.js';
import { refundReservation, type CreditReservation, type CreditUsage } from '../../lib/credits-manager.js';
import { handleDeepResearch } from '../../lib/chat-modes/deep-research-handler.js';
import {
  saveConversationResult,
  generateTitleAsync,
  startParallelTitleGeneration,
  finalizeChatCredits,
  runPostChatHooks,
  notifyDisconnectedClient,
  type LifecycleContext,
} from '../../lib/chat-lifecycle.js';
import { ToolPipeline } from '../../lib/tool-pipeline.js';
import { createResponseSSEEmitter } from '../../lib/sse-emitter.js';
import { SystemPromptBuilder } from '../../lib/system-prompt-builder.js';
import { convertToAISDKMessages, type ChatMessage } from '../../lib/message-converter.js';
import { estimateMessageTokens } from '../../lib/token-counter.js';
import { wrapToolsWithTruncation, getToolResultBudget } from '../../lib/tools/result-truncation.js';
import { log } from '../../lib/logger.js';
import { recordEvent } from '../../lib/observability/index.js';
import { classifyError, getRetryAfterHeader } from '../../lib/errors/index.js';
import { writeStopChunk, writeContentChunk, makeChunk } from '../../lib/streaming-helpers.js';
import { buildCompletionResponse } from '../../lib/chat/response-shapes.js';
import { SSEWriter } from '../../lib/chat/sse-writer.js';
import { buildChatRequestContext } from '../../lib/chat/request-context.js';
import { runStream, type AgentMessage } from '../../lib/chat/stream-runner.js';
import { runTextToolFallback } from '../../lib/chat/text-tool-fallback.js';
import type { FailoverReason } from '../../lib/errors/error-codes.js';
import type { IAgent } from '../../models/agent.js';

const router = Router();

/** Errors that should NOT be retried on a different provider (model-level issues, not provider-level) */
const NON_RETRYABLE_STREAM: Set<FailoverReason> = new Set(['format', 'content_filter']);

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint with streaming support
 */
export const handleChatCompletions = async (req: Request, res: Response) => {
  let creditReservation: CreditReservation | null = null;
  let resolved: Awaited<ReturnType<typeof resolveModel>> = null;
  let aliasModelId: string = 'alia-v1';
  const requestStartTime = Date.now();
  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  const sse = new SSEWriter(res);

  // Global request timeout guard — send a proper error BEFORE DO's gateway timeout (~120s)
  const GLOBAL_TIMEOUT_MS = 80_000;
  let globalTimedOut = false;
  const globalTimer = setTimeout(() => {
    globalTimedOut = true;
    log.v1.error('Global request timeout after 80s');
    if (!res.headersSent) {
      // Return synthetic response instead of raw error
      res.json(buildCompletionResponse({
        requestId,
        model: aliasModelId,
        content: "I'm sorry, the request took too long. Please try again.",
        aliaMeta: { synthetic: true, retryable: true },
      }));
    } else if (!res.writableEnded) {
      // Mid-stream timeout: send graceful finish
      writeContentChunk(res, requestId, aliasModelId, '\n\nI encountered a brief interruption. Please send your message again.');
      writeStopChunk(res, requestId, aliasModelId);
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
    creditReservation = ctx.creditReservation;
    resolved = ctx.resolved;
    aliasModelId = ctx.aliasModelId;
    const { autonomyRuntime, recalledMemories } = ctx;

    // ── Deep Research Mode ──
    if (deepResearch && req.user?.id) {
      const handled = await handleDeepResearch({
        res,
        requestId,
        aliasModelId,
        userId: req.user.id,
        conversationId,
        messages,
        creditReservation,
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
      aliasModelId,
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

    // Track token usage
    let tokenUsage: CreditUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      systemPromptTokens,
    };

    // Wrap tools with truncation to cap large results (saves tokens)
    const aliaModelInfo = await getAliaModel(aliasModelId);
    const tierMappings = aliaModelInfo ? await getModelMappingsForTier(aliaModelInfo.tier) : [];
    const modelContextTokens = (tierMappings[0]?.capabilities?.maxContextTokens as number) || 128000;
    const truncatedTools = wrapToolsWithTruncation(allTools, getToolResultBudget(modelContextTokens));
    log.v1.info({ toolNames: Object.keys(truncatedTools), toolCount: Object.keys(truncatedTools).length }, 'Tools passed to model');

    // Record agent.start for observability
    recordEvent({
      type: 'agent.start',
      timestamp: requestStartTime,
      modelId: aliasModelId,
      provider: resolved?.provider,
    });

    // Tool tracking for observability
    let toolCallCount = 0;

    // Provider fallback retry loop
    // Dynamic retry budget: try every configured provider in the tier, minimum 5
    const MAX_PROVIDER_RETRIES = Math.max(tierMappings.length, 5);
    const skipProviders = new Set<string>();
    const failedKeyIds = new Set<string>();

    /** Reasons that indicate a key-level failure (try next key, not next provider) */
    const KEY_LEVEL_REASONS: Set<FailoverReason> = new Set(['auth', 'rate_limit']);

    // Detect user language for graceful error messages
    const lastUserMsg = messages.slice().reverse().find((m: ChatMessage) => m.role === 'user');
    const lastUserText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
    const isSpanish = /[áéíóúñ¿¡]/.test(lastUserText) || /\b(hola|por favor|gracias|cómo|qué|dime|puedes)\b/i.test(lastUserText);

    // Plan previews are now AI-generated via the planPreview tool (not autonomy runtime)

    for (let providerAttempt = 0; providerAttempt < MAX_PROVIDER_RETRIES; providerAttempt++) {
    // Check global timeout before each provider attempt
    if (globalTimedOut) break;

    // Check time budget before each attempt (leave 5s for last-resort response)
    const elapsedMs = Date.now() - requestStartTime;
    if (elapsedMs > GLOBAL_TIMEOUT_MS - 10_000) {
      log.v1.warn({ elapsedMs }, 'Time budget nearly exhausted, breaking retry loop');
      break;
    }

    // Re-resolve model on retry (skipping failed providers and keys)
    if (providerAttempt > 0) {
      resolved = await resolveModel(requestedModel, skipProviders, failedKeyIds);
      if (!resolved) {
        log.v1.warn({ retries: providerAttempt }, 'No more providers available after retries');
        break;
      }
      aliasModelId = resolved.aliasModelId;
      log.v1.info({ attempt: providerAttempt, provider: resolved.provider, modelId: resolved.modelId }, 'Retrying with provider');
    }

    const model = getAIModel(resolved!.keyConfig);

    // Build common config for both streaming and non-streaming
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK config is dynamically extended; strict SDK param types don't support this pattern
    const baseConfig: any = {
      model,
      messages: convertedMessages,
      temperature: body.temperature ?? 0.7,
      tools: truncatedTools,
      maxRetries: 0, // Fail fast to application-level provider fallback
      // AI SDK v6: stopWhen replaces maxSteps. Without this, the SDK defaults to
      // stepCountIs(1) which stops after tool calls without generating a text response.
      stopWhen: stepCountIs(5),
      onFinish: async (result: { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }) => {
        // Capture token usage from AI SDK
        if (result.usage) {
          tokenUsage = {
            promptTokens: result.usage.inputTokens || 0,
            completionTokens: result.usage.outputTokens || 0,
            totalTokens: result.usage.totalTokens || 0,
            systemPromptTokens, // Keep our estimated system prompt tokens
          };
          log.v1.info({ usage: tokenUsage }, 'Token usage captured');
        }
      },
    };

    if (body.max_tokens) {
      baseConfig.maxTokens = body.max_tokens;
    }

    // Enable thinking mode for Anthropic if requested
    if (thinkingMode && resolved!.provider === 'anthropic') {
      baseConfig.experimental_thinking = true;
      log.v1.info('Enabled Anthropic thinking mode');
    }

    // Configure provider-specific features for reasoning
    const providerMetadata: Record<string, Record<string, unknown>> = {};

    if (resolved!.provider === 'google') {
      // Enable thought summaries for Gemini
      providerMetadata.google = { includeThoughts: true };
      log.v1.info('Enabled Gemini thought summaries');
    }

    if (Object.keys(providerMetadata).length > 0) {
      baseConfig.experimental_providerMetadata = providerMetadata;
    }

    if (process.env.NODE_ENV !== 'production') {
      log.v1.debug({
        modelProvider: resolved!.provider,
        model: resolved!.keyConfig.modelId,
        messageCount: baseConfig.messages.length,
        toolCount: baseConfig.tools ? Object.keys(baseConfig.tools).length : 0,
        stream: body.stream
      }, 'AI SDK config');
    }

    // Shared with the stream runner + provider-retry catch: reflects writes made
    // inside runStream even when the stream throws mid-flight.
    const streamState = { hasStreamedContent: false };

    // Per-provider first-byte timeout — abort if no response within 20s
    const FIRST_BYTE_TIMEOUT_MS = 20_000;
    const providerAbort = new AbortController();
    let firstByteTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (!streamState.hasStreamedContent) {
        log.v1.warn({ provider: resolved!.provider, modelId: resolved!.modelId, timeoutMs: FIRST_BYTE_TIMEOUT_MS }, 'Provider first-byte timeout');
        providerAbort.abort(new Error('Provider first-byte timeout'));
      }
    }, FIRST_BYTE_TIMEOUT_MS);
    baseConfig.abortSignal = providerAbort.signal;
    const clearFirstByteTimer = () => { if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; } };

    try { // Provider attempt try block

    // Handle non-streaming requests
    if (body.stream !== true) {
      log.v1.info('Non-streaming request, using generateText');

      const result = await generateText(baseConfig);
      clearFirstByteTimer();

      // Capture token usage (AI SDK uses inputTokens/outputTokens)
      if (result.usage) {
        tokenUsage = {
          promptTokens: result.usage.inputTokens || 0,
          completionTokens: result.usage.outputTokens || 0,
          totalTokens: result.usage.totalTokens || 0,
          systemPromptTokens,
        };
        log.v1.info({ usage: tokenUsage }, 'Token usage');
      }

      const assistantResponse = result.text || '';

      // Build tool invocations from generateText result
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK TypedToolCall shape varies per tool config
      const nonStreamToolInvocations = (result.toolCalls || []).map((tc: any) => {
        const toolResult = (result.toolResults || []).find((tr: any) => tr.toolCallId === tc.toolCallId);
        return {
          toolCallId: tc.toolCallId,
          toolName: toolNameMapping.get(tc.toolName) || tc.toolName,
          state: toolResult ? 'result' as const : 'call' as const,
          args: tc.args,
          ...(toolResult && { result: toolResult.output }),
        };
      });

      // Build lifecycle context for post-request operations
      const lifecycleCtx: LifecycleContext = {
        userId: req.user?.id,
        conversationId,
        messages,
        aliasModelId,
        creditReservation,
        tokenUsage,
        requestStartTime,
        skillId: body.skillId,
        isApiKey: !!req.apiKey,
        autonomyRuntime,
      };

      // Save conversation + generate title
      await saveConversationResult(lifecycleCtx, assistantResponse, nonStreamToolInvocations);
      if (conversationId && req.user?.id && assistantResponse) {
        generateTitleAsync(req.user.id, conversationId, messages);
      }

      // Finalize credits + detect anomalies
      const { creditsCharged, creditsRemaining, creditWarning } = await finalizeChatCredits(lifecycleCtx, req);

      // Fire afterChat hooks (non-blocking)
      runPostChatHooks(lifecycleCtx, assistantResponse);

      // Build tool_calls array if there were any tool calls
      const toolCalls = result.toolCalls?.map((tc: { toolCallId?: string; toolName: string; args?: unknown }, index: number) => {
        const originalToolName = toolNameMapping.get(tc.toolName) || tc.toolName;
        return {
          id: tc.toolCallId || `call_${Date.now()}_${index}`,
          type: 'function' as const,
          function: {
            name: originalToolName,
            arguments: JSON.stringify(tc.args || {})
          }
        };
      });

      // Return OpenAI-compatible non-streaming response
      res.json(buildCompletionResponse({
        requestId,
        model: aliasModelId,
        content: assistantResponse,
        finishReason: result.finishReason || 'stop',
        toolCalls,
        usage: tokenUsage,
        aliaUsage: {
          system_prompt_tokens: tokenUsage.systemPromptTokens || 0,
          billable_tokens: Math.max(0, tokenUsage.totalTokens - (tokenUsage.systemPromptTokens || 0)),
          credits_charged: creditsCharged,
          credits_remaining: creditsRemaining,
          credit_warning: creditWarning,
        },
      }));
      clearTimeout(globalTimer);
      return;
    }

    // Start title generation in parallel for new conversations (runs during streaming)
    let titlePromise: Promise<string | null> | null = null;
    if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user) {
      titlePromise = startParallelTitleGeneration(req.user.id, conversationId, messages).catch(() => null);
    }

    // Streaming request
    const result = streamText(baseConfig);

    // Periodic keep-alive during stream processing — prevents proxy timeouts
    // during multi-step LLM calls (e.g. the follow-up request after tool execution).
    sse.startKeepAlive();

    // Track client disconnect so we can send a push notification if the response completes after they leave
    let clientDisconnected = false;
    const onClientClose = () => { clientDisconnected = true; };
    req.on('close', onClientClose);

    // Stream OpenAI-compatible chunks
    const streamResult = await runStream({
      result,
      res,
      sse,
      requestId,
      aliasModelId,
      resolved: resolved!,
      baseConfig,
      convertedMessages,
      toolNameMapping,
      agentMessages,
      isSpanish,
      toolCallCount,
      state: streamState,
      onFirstChunk: clearFirstByteTimer,
    });
    let assistantResponse = streamResult.assistantResponse;
    const toolInvocations = streamResult.toolInvocations;
    toolCallCount = streamResult.toolCallCount;

    sse.stopKeepAlive();
    log.v1.info({ totalChunks: streamResult.chunkCount }, 'Stream processing complete');

    // ── Text-based tool call fallback ──
    // Some models (Gemini 3 preview, Minimax, etc.) output tool calls as text
    // instead of using the native tool calling API. Detect and execute them.
    assistantResponse = (await runTextToolFallback({
      assistantResponse,
      toolInvocations,
      tools: truncatedTools,
      convertedMessages,
      baseConfig,
      res,
      requestId,
      aliasModelId,
      resolved: resolved!,
    })).assistantResponse;

    // Build lifecycle context for post-stream operations
    const lifecycleCtx: LifecycleContext = {
      userId: req.user?.id,
      conversationId,
      messages,
      aliasModelId,
      creditReservation,
      tokenUsage,
      requestStartTime,
      skillId: body.skillId,
      isApiKey: !!req.apiKey,
      autonomyRuntime,
    };

    // Save conversation
    await saveConversationResult(lifecycleCtx, assistantResponse, toolInvocations, agentMessages);

    // Send AI-generated title via SSE (generated in parallel with streaming)
    if (titlePromise && conversationId && req.user) {
      try {
        const title = await titlePromise;
        if (title) {
          res.write(`event: alia.title\ndata: ${JSON.stringify({ eventVersion: 1, title, conversationId })}\n\n`);
          await Conversation.updateOne(
            { oxyUserId: req.user.id, conversationId },
            { $set: { title } },
          );
          log.v1.info({ conversationId, title }, 'Auto-generated conversation title');
        }
      } catch (err) {
        log.v1.error({ err }, 'Failed to send inline title');
      }
    }

    // Finalize credits + send usage chunk
    const { creditsCharged, creditsRemaining, creditWarning } = await finalizeChatCredits(lifecycleCtx, req);
    if (includeUsage && creditReservation && req.user) {
      const usageChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: aliasModelId,
        system_fingerprint: 'fp_alia',
        service_tier: 'default',
        choices: [],
        usage: {
          prompt_tokens: tokenUsage.promptTokens,
          completion_tokens: tokenUsage.completionTokens,
          total_tokens: tokenUsage.totalTokens,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        },
        alia_usage: {
          system_prompt_tokens: tokenUsage.systemPromptTokens || 0,
          billable_tokens: Math.max(0, tokenUsage.totalTokens - (tokenUsage.systemPromptTokens || 0)),
          credits_charged: creditsCharged,
          credits_remaining: creditsRemaining,
          credit_warning: creditWarning,
        },
      };
      res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
    }

    // Fire afterChat hooks + autonomy (non-blocking)
    runPostChatHooks(lifecycleCtx, assistantResponse);

    // Record agent.end for observability (success path)
    recordEvent({
      type: 'agent.end',
      timestamp: Date.now(),
      durationMs: Date.now() - requestStartTime,
      inputTokens: tokenUsage.promptTokens,
      outputTokens: tokenUsage.completionTokens,
      toolCallCount,
    });

    sse.stopKeepAlive();
    req.off('close', onClientClose);
    res.write('data: [DONE]\n\n');
    res.end();
    clearTimeout(globalTimer);

    // If the client disconnected before the stream finished, send a push notification
    if (clientDisconnected && req.user?.id && body.conversationId) {
      notifyDisconnectedClient(req.user.id, body.conversationId, assistantResponse);
    }

    return; // Success - exit the route handler

    } catch (providerError: unknown) {
      // Clean up timers on provider failure
      sse.stopKeepAlive();
      clearFirstByteTimer();
      // Provider attempt failed — classify with shared error classifier
      log.v1.error({ err: providerError, provider: resolved!.provider, modelId: resolved!.modelId }, 'Provider failed');
      const errorReason = classifyError(providerError);
      const retryAfterSec = getRetryAfterHeader(providerError);
      const retryAfterMs = retryAfterSec ? retryAfterSec * 1000 : undefined;
      await reportModelUsage(resolved!.keyConfig?.keyId, resolved!.provider, resolved!.modelId, false, 0, errorReason, retryAfterMs);

      // Non-retryable errors: stop immediately (would fail on any provider)
      if (NON_RETRYABLE_STREAM.has(errorReason)) {
        if (streamState.hasStreamedContent) throw providerError;
        break; // Fall through to last-resort response
      }

      // If content already streamed, can't retry — fall to outer handler
      if (streamState.hasStreamedContent) {
        throw providerError;
      }

      // Discriminate key-level vs provider-level failures for smarter retry
      if (KEY_LEVEL_REASONS.has(errorReason) && resolved!.keyConfig?.keyId) {
        // Key-level: skip just this key, keep the provider available
        failedKeyIds.add(resolved!.keyConfig.keyId);
        log.v1.info({ provider: resolved!.provider, reason: errorReason, keyId: resolved!.keyConfig.keyId }, 'Key-level failure, retrying with different key');
      } else if (errorReason === 'provider_unavailable' || errorReason === 'billing') {
        // Provider-level: skip the entire provider
        skipProviders.add(resolved!.provider);
        log.v1.info({ provider: resolved!.provider, reason: errorReason }, 'Provider-level failure, skipping provider');
      } else {
        // timeout, unknown: skip provider to try a different one
        skipProviders.add(resolved!.provider);
        log.v1.info({ provider: resolved!.provider, reason: errorReason }, 'Provider failed, trying next provider');
      }

      if (providerAttempt < MAX_PROVIDER_RETRIES - 1) {
        continue; // Try next provider/key
      }

      // Last attempt exhausted — fall through to last-resort response
      break;
    }

    } // End of provider retry loop

    // ── LAST-RESORT SYNTHETIC RESPONSE ──
    // All providers exhausted or time budget exceeded — respond with a friendly
    // message instead of an error so the client never sees a raw failure.
    log.v1.warn({ attempts: skipProviders.size + failedKeyIds.size, model: requestedModel }, 'All providers exhausted, sending synthetic response');

    const syntheticMessage = isSpanish
      ? 'Lo siento, en este momento todos los modelos están ocupados. Por favor, intenta de nuevo en unos segundos.'
      : "I'm sorry, all models are currently busy. Please try again in a few seconds.";

    // Refund credit reservation for synthetic responses
    if (creditReservation) {
      refundReservation(creditReservation).catch((err: unknown) => log.v1.error({ err, reservationId: creditReservation?.userId }, 'refundReservation failed for synthetic response'));
      creditReservation = null;
    }

    clearTimeout(globalTimer);

    if (!sse.sent && !res.headersSent) {
      // Non-streaming: return standard JSON response
      res.json(buildCompletionResponse({
        requestId,
        model: aliasModelId,
        content: syntheticMessage,
        aliaMeta: { synthetic: true, retryable: true },
      }));
    } else {
      // Streaming: send synthetic message as normal SSE chunks
      sse.ensureHeaders();
      const syntheticChunk = { ...makeChunk(requestId, aliasModelId, [{ index: 0, delta: { content: syntheticMessage }, finish_reason: null }]), alia_meta: { synthetic: true, retryable: true } };
      res.write(`data: ${JSON.stringify(syntheticChunk)}\n\n`);
      writeStopChunk(res, requestId, aliasModelId);
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
    const aliaError = toAliaError(e, { provider: resolved?.provider, model: resolved?.modelId });

    if (!res.headersSent) {
      res.status(aliaError.retryable ? 503 : 500).json(formatErrorResponse(aliaError));
    } else if (!res.writableEnded) {
      // Headers already sent (streaming started) — send graceful recovery message
      writeContentChunk(res, requestId, aliasModelId, '\n\nI encountered a brief interruption. Please send your message again and I\'ll complete my response.');
      writeStopChunk(res, requestId, aliasModelId);
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
