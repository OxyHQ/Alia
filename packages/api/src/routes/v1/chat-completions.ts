import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { streamText, generateText, stepCountIs } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel, reportModelUsage } from '../../lib/chat-core.js';
import { getAliaModel, getModelMappingsForTier } from '../../lib/gateway-client.js';
import { UserMemory } from '../../models/user-memory.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { Conversation } from '../../models/conversation.js';
import { reserveCredits, refundReservation, type CreditReservation, type CreditUsage } from '../../lib/credits-manager.js';
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
import { getUserEntitlements } from '../../lib/plan-access.js';
import { ToolPipeline } from '../../lib/tool-pipeline.js';
import { createResponseSSEEmitter } from '../../lib/sse-emitter.js';
import { SystemPromptBuilder } from '../../lib/system-prompt-builder.js';
import { convertToAISDKMessages, type ChatMessage } from '../../lib/message-converter.js';
import { oxyClient } from '../../middleware/auth.js';
import { Skill } from '../../models/skill.js';
import { estimateMessageTokens } from '../../lib/token-counter.js';
import { runBeforeChatHooks } from '../../lib/hooks/index.js';
import { wrapToolsWithTruncation, getToolResultBudget } from '../../lib/tools/result-truncation.js';
import { log } from '../../lib/logger.js';
import { recordEvent } from '../../lib/observability/index.js';
import { classifyError, getRetryAfterHeader } from '../../lib/errors/index.js';
import { setupSSEHeaders, writeTextChunk, writeStopChunk, writeContentChunk, makeChunk } from '../../lib/streaming-helpers.js';
import type { FailoverReason } from '../../lib/errors/error-codes.js';
import { Agent as AgentModel, type IAgent } from '../../models/agent.js';
import {
  runAutonomyBeforeChat,
  type AutonomyRuntimeContext,
} from '../../lib/autonomy/runtime.js';

const router = Router();

/** Extended stream chunk types not yet exported by AI SDK */
type ExtendedChunk = { type: string; text?: string; thoughtDelta?: string; reasoningDelta?: string; toolName?: string; error?: Error & { message: string }; [key: string]: unknown };

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
  let autonomyRuntime: AutonomyRuntimeContext | null = null;
  let recalledMemories: Array<{ key: string; value: string }> | undefined;

  // Global request timeout guard — send a proper error BEFORE DO's gateway timeout (~120s)
  const GLOBAL_TIMEOUT_MS = 80_000;
  let globalTimedOut = false;
  const globalTimer = setTimeout(() => {
    globalTimedOut = true;
    log.v1.error('Global request timeout after 80s');
    if (!res.headersSent) {
      // Return synthetic response instead of raw error
      res.json({
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: aliasModelId,
        system_fingerprint: 'fp_alia',
        service_tier: 'default',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: "I'm sorry, the request took too long. Please try again.", refusal: null },
          logprobs: null,
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        },
        alia_meta: { synthetic: true, retryable: true },
      });
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
    const body = req.body;

    // Validate request body
    if (!body || typeof body !== 'object') {
      res.status(400).json({
        error: {
          message: 'Request body must be a JSON object.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_request_body',
        }
      });
      return;
    }

    // Support both "messages" (OpenAI standard) and "input" (Cursor format)
    const messages = body.messages || body.input;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: {
          message: 'Request body must include a "messages" array with at least one message.',
          type: 'invalid_request_error',
          param: 'messages',
          code: 'invalid_messages',
        }
      });
      return;
    }

    // Extract optional parameters for Alia internal features
    const conversationId = body.conversationId as string | undefined;
    const thinkingMode = body.thinkingMode as boolean | undefined;
    const agentMode = (body.agentMode as boolean | undefined) ?? false;
    const deepResearch = body.deepResearch as boolean | undefined;
    const streamOptions = body.stream_options as { include_usage?: boolean } | undefined;
    const includeUsage = streamOptions?.include_usage === true;

    log.v1.info({ messageCount: messages.length, conversationId, thinkingMode, agentMode, deepResearch }, 'Processing messages');

    if (req.user?.id) {
      autonomyRuntime = await runAutonomyBeforeChat({
        userId: req.user.id,
        messages,
      }).catch(() => null);
    }

    // Determine if this is a direct user session (not API key)
    // API key requests should be neutral and not include creator's personal info
    const isDirectUserSession = !!req.user && !req.apiKey;
    const requestedModel = body.model || getDefaultAliaModel();

    // Extract client context from first system message if present (from editor/client)
    let clientContext: string | undefined;
    if (messages.length > 0 && messages[0].role === 'system') {
      clientContext = messages[0].content as string;
    }

    // For streaming requests, send SSE headers immediately — before any async work.
    // This gives the client instant feedback that the connection is established and
    // prevents proxy timeouts during pre-stream operations.
    let earlySSE = false;
    if (body.stream === true) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) {
        res.socket.setNoDelay(true);
      }
      res.write(': keep-alive\n\n');
      res.flushHeaders();
      earlySSE = true;
    }

    /** Send an error over the SSE stream and end the response (used when headers already sent). */
    function sendSSEError(errorPayload: Record<string, any>) {
      const openAIError = {
        error: {
          message: errorPayload.message || 'An error occurred.',
          type: errorPayload.type || 'server_error',
          param: errorPayload.param || null,
          code: errorPayload.code || null,
        },
      };
      res.write(`data: ${JSON.stringify(openAIError)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }

    // --- PARALLEL PRE-STREAMING OPERATIONS ---
    // Run independent operations concurrently to reduce time-to-first-token
    const preStreamStart = Date.now();

    const [creditResult, resolvedResult, userMemory, oxyUser, skill, entitlements, linkedAgent] = await Promise.all([
      // Credits: sequential pair (getOrCreate → reserve), parallel with everything else
      // Skip for internal service requests (no credits charged)
      (req.user && !req.serviceApp) ? (async () => {
        await getOrCreateUserCredits(req.user!.id);
        const reservation = await reserveCredits(req.user!.id);
        return { reservation, error: false as const };
      })().catch((error) => {
        log.v1.error({ err: error }, 'Error reserving credits');
        return { reservation: null, error: true as const };
      }) : Promise.resolve({ reservation: null, error: false as const }),

      // Model resolution (includes key loading, rate limit checks, circuit breaker)
      resolveModel(requestedModel).catch((err) => {
        log.v1.error({ err }, 'Error resolving model');
        return null;
      }),

      // User memory
      req.user
        ? UserMemory.findOne({ oxyUserId: req.user.id }).catch(() => null)
        : Promise.resolve(null),

      // User profile from Oxy (HTTP call - add 5s timeout to prevent hanging)
      isDirectUserSession
        ? Promise.race([
            (oxyClient.getUserById(req.user!.id) as Promise<unknown>),
            new Promise(resolve => setTimeout(() => resolve(null), 5000))
          ]).catch(() => null)
        : Promise.resolve(null),

      // Skill loading
      (body.skillId && isDirectUserSession)
        ? Skill.findOne({ skillId: body.skillId }).select('systemPrompt title').lean().catch(() => null)
        : Promise.resolve(null),

      // User entitlements (plan-based model access) — parallelized to avoid sequential delay
      (req.user && !req.apiKey)
        ? getUserEntitlements(req.user.id).catch(() => null)
        : Promise.resolve(null),

      // Linked agent (for archetype prompt injection — Q&A agents, etc.)
      (conversationId && isDirectUserSession)
        ? Conversation.findById(conversationId).select('agentId').lean()
            .then(conv => conv?.agentId
              ? AgentModel.findById(conv.agentId).select('name archetype archetypeConfig systemPrompt knowledge').lean()
              : null)
            .catch(() => null) as Promise<IAgent | null>
        : Promise.resolve(null),
    ]);

    log.v1.info({ durationMs: Date.now() - preStreamStart }, 'Pre-stream setup complete');

    // Validate credit reservation
    // Only return 402 if reserveCredits explicitly returned null (insufficient credits),
    // not if there was a DB error (original behavior: continue without credits on error)
    creditReservation = creditResult.reservation;
    if (req.user && !req.serviceApp && !creditReservation && !creditResult.error) {
      clearTimeout(globalTimer);
      const creditError = {
        message: "You've run out of credits. Add more or upgrade your plan to continue.",
        type: 'invalid_request_error',
        param: null,
        code: 'INSUFFICIENT_CREDITS',
      };
      if (earlySSE) {
        sendSSEError(creditError);
      } else {
        res.status(402).json({ error: creditError });
      }
      return;
    }

    // Validate model resolution
    resolved = resolvedResult;
    if (!resolved) {
      clearTimeout(globalTimer);
      const noModelsError = {
        message: 'No models available. Please try again.',
        type: 'server_error',
        param: 'model',
        code: 'model_not_available',
      };
      if (earlySSE) {
        sendSSEError(noModelsError);
      } else {
        res.status(503).json({ error: noModelsError });
      }
      return;
    }

    aliasModelId = resolved.aliasModelId;
    log.v1.info({ provider: resolved.provider, modelId: resolved.modelId }, 'Using provider');

    // Enforce plan-based model access (skip for API-key requests)
    // Uses entitlements prefetched in Promise.all above
    if (req.user && !req.apiKey && entitlements) {
      if (!entitlements.allowedModelIds.includes(aliasModelId)) {
        if (creditReservation) await refundReservation(creditReservation);
        clearTimeout(globalTimer);
        const modelError = {
          message: 'Upgrade your plan to use this model.',
          type: 'invalid_request_error',
          param: 'model',
          code: 'MODEL_NOT_IN_PLAN',
        };
        if (earlySSE) {
          sendSSEError(modelError);
        } else {
          res.status(403).json({ error: modelError });
        }
        return;
      }
    }

    if (req.user?.id) {
      const hookResult = await runBeforeChatHooks({
        userId: req.user.id,
        conversationId,
        messages,
        model: aliasModelId,
        skillId: body.skillId,
        platform: req.apiKey ? 'telegram' as const : 'app' as const,
        metadata: {},
      }).catch(() => null);
      recalledMemories = hookResult?.metadata?.recalledMemories as Array<{ key: string; value: string }> | undefined;
    }

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
    const sseEmitter = createResponseSSEEmitter(res, ensureSSEHeaders);
    const { tools: allTools, toolNameMapping } = await ToolPipeline.forUser({
      userId: req.user?.id || '',
      accessToken: req.accessToken,
      isDirectSession: isDirectUserSession,
      agentMode,
      username: (oxyUser as any)?.username,
      requestId,
      editorToolDefinitions: body.tools,
      sseEmitter,
    });

    // Agent mode: full agent escalation for linked conversations
    const agentMessages: Array<{ role: 'assistant'; content: string; agentInfo: { id: string; name: string; avatar: string | null; handle: string } }> = [];
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
      oxyUser: oxyUser as any,
      userMemory: userMemory as any,
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
    const toolTimers = new Map<string, number>();
    let toolCallCount = 0;
    const MAX_TOOL_CALLS = 15;

    // Provider fallback retry loop
    // Dynamic retry budget: try every configured provider in the tier, minimum 5
    const MAX_PROVIDER_RETRIES = Math.max(tierMappings.length, 5);
    const skipProviders = new Set<string>();
    const failedKeyIds = new Set<string>();
    let sseHeadersSent = earlySSE;

    /** Reasons that indicate a key-level failure (try next key, not next provider) */
    const KEY_LEVEL_REASONS: Set<FailoverReason> = new Set(['auth', 'rate_limit']);

    // Detect user language for graceful error messages
    const lastUserMsg = messages.slice().reverse().find((m: ChatMessage) => m.role === 'user');
    const lastUserText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
    const isSpanish = /[áéíóúñ¿¡]/.test(lastUserText) || /\b(hola|por favor|gracias|cómo|qué|dime|puedes)\b/i.test(lastUserText);

    /** Set SSE headers if not already sent (idempotent). */
    function ensureSSEHeaders() {
      if (!sseHeadersSent) {
        setupSSEHeaders(res);
        sseHeadersSent = true;
      }
    }

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

    let hasStreamedContent = false;
    let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

    // Per-provider first-byte timeout — abort if no response within 20s
    const FIRST_BYTE_TIMEOUT_MS = 20_000;
    const providerAbort = new AbortController();
    let firstByteTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (!hasStreamedContent) {
        log.v1.warn({ provider: resolved!.provider, modelId: resolved!.modelId, timeoutMs: FIRST_BYTE_TIMEOUT_MS }, 'Provider first-byte timeout');
        providerAbort.abort(new Error('Provider first-byte timeout'));
      }
    }, FIRST_BYTE_TIMEOUT_MS);
    baseConfig.abortSignal = providerAbort.signal;

    try { // Provider attempt try block

    // Handle non-streaming requests
    if (body.stream !== true) {
      log.v1.info('Non-streaming request, using generateText');

      const result = await generateText(baseConfig);
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }

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
          type: 'function',
          function: {
            name: originalToolName,
            arguments: JSON.stringify(tc.args || {})
          }
        };
      });

      // Return OpenAI-compatible non-streaming response
      const response = {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: aliasModelId,
        system_fingerprint: 'fp_alia',
        service_tier: 'default',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: assistantResponse,
            refusal: null,
            ...(toolCalls && toolCalls.length > 0 && { tool_calls: toolCalls })
          },
          logprobs: null,
          finish_reason: result.finishReason || 'stop'
        }],
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

      res.json(response);
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

    // Periodic keep-alive during stream processing.
    // Prevents proxy timeouts during multi-step LLM calls (e.g., after tool execution
    // when the AI SDK makes a second LLM request with the tool result).
    const KEEPALIVE_INTERVAL_MS = 15_000;
    keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, KEEPALIVE_INTERVAL_MS);

    // Track client disconnect so we can send a push notification if the response completes after they leave
    let clientDisconnected = false;
    const onClientClose = () => { clientDisconnected = true; };
    req.on('close', onClientClose);

    // Stream OpenAI-compatible chunks
    log.v1.info('Starting to process AI SDK stream');
    let chunkCount = 0;
    let assistantResponse = ''; // Track assistant's response for conversation save
    let hasStreamedText = false; // Track whether actual text (not just tool calls) was streamed
    const toolInvocations: Array<{ toolCallId: string; toolName: string; state: 'call' | 'result'; args?: unknown; result?: unknown }> = [];
    for await (const chunk of result.fullStream) {
      chunkCount++;
      // Clear first-byte timer on first chunk (provider responded)
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      // Log chunk type (skip high-frequency text-delta to reduce noise)
      if (chunk.type !== 'text-delta') {
        log.v1.debug({ chunkCount, chunkType: chunk.type }, 'Stream chunk');
      }

      if (chunk.type === 'text-delta' && chunk.text) {
        ensureSSEHeaders();
        hasStreamedContent = true;
        hasStreamedText = true;

        // Extract <thinking> tags for chain-of-thought (Anthropic, DeepSeek, etc.)
        const thinkingMatch = chunk.text.match(/<thinking>([\s\S]*?)<\/thinking>/g);
        if (thinkingMatch) {
          // Send thinking content as named SSE event (non-standard, Alia extension)
          thinkingMatch.forEach(match => {
            const content = match.replace(/<\/?thinking>/g, '').trim();
            if (content) {
              res.write(`event: alia.reasoning\ndata: ${JSON.stringify({ eventVersion: 1, content })}\n\n`);
              log.v1.debug({ reasoning: content.slice(0, 100) }, 'Reasoning chunk (thinking tag)');
            }
          });
        }

        // Filter out thinking tags and stream as OpenAI-compatible chunk
        const filtered = writeTextChunk(res, requestId, aliasModelId, chunk.text);
        if (filtered) {
          assistantResponse += filtered;
        }
      } else if ((chunk as ExtendedChunk).type === 'thought-delta' || (chunk as ExtendedChunk).type === 'reasoning-delta') {
        ensureSSEHeaders();
        hasStreamedContent = true;

        // Handle Gemini thought summaries and other reasoning tokens
        const reasoningText = (chunk as ExtendedChunk).text || (chunk as ExtendedChunk).thoughtDelta || (chunk as ExtendedChunk).reasoningDelta;
        if (reasoningText && typeof reasoningText === 'string' && reasoningText.trim()) {
          res.write(`event: alia.reasoning\ndata: ${JSON.stringify({ eventVersion: 1, content: reasoningText.trim() })}\n\n`);
          log.v1.debug({ reasoning: reasoningText.slice(0, 100) }, 'Reasoning chunk (provider)');
        }
      } else if (chunk.type === 'tool-call') {
        ensureSSEHeaders();
        hasStreamedContent = true;

        // Restore original tool name if it was sanitized
        const originalToolName = toolNameMapping.get(chunk.toolName) || chunk.toolName;

        // Log the tool call arguments being sent to the client
        log.v1.info({ toolName: originalToolName, args: chunk.input }, 'Streaming tool call');

        res.write(`data: ${JSON.stringify(makeChunk(requestId, aliasModelId, [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: chunk.toolCallId, type: 'function', function: { name: originalToolName, arguments: JSON.stringify(chunk.input || {}) } }] },
          finish_reason: null,
        }]))}\n\n`);

        // Track tool invocation for conversation save
        toolInvocations.push({
          toolCallId: chunk.toolCallId,
          toolName: originalToolName,
          state: 'call',
          args: chunk.input,
        });

        // Track tool call timing (start)
        toolTimers.set(chunk.toolCallId, Date.now());
        toolCallCount++;

        // Tool iteration guard
        if (toolCallCount > MAX_TOOL_CALLS) {
          log.v1.warn({ toolCallCount, MAX_TOOL_CALLS }, 'Tool call limit exceeded, breaking stream');
          recordEvent({ type: 'error', timestamp: Date.now(), code: 'TOOL_LIMIT_EXCEEDED', message: `Exceeded ${MAX_TOOL_CALLS} tool calls` });
          break;
        }
      } else if (chunk.type === 'tool-result') {
        ensureSSEHeaders();
        hasStreamedContent = true;

        const originalToolName = toolNameMapping.get(chunk.toolName) || chunk.toolName;
        log.v1.info({ toolName: originalToolName, output: chunk.output }, 'Tool result');

        // Record tool.call observability event
        const toolStart = toolTimers.get(chunk.toolCallId);
        if (toolStart) {
          recordEvent({ type: 'tool.call', timestamp: Date.now(), toolName: originalToolName, durationMs: Date.now() - toolStart, success: true });
          toolTimers.delete(chunk.toolCallId);
        }

        // Stream tool result as named SSE event (non-standard, Alia extension)
        res.write(`event: alia.tool_result\ndata: ${JSON.stringify({
          eventVersion: 1,
          tool_call_id: chunk.toolCallId,
          name: originalToolName,
          output: chunk.output,
        })}\n\n`);

        // Update tool invocation state for conversation save
        const existingIdx = toolInvocations.findIndex(t => t.toolCallId === chunk.toolCallId);
        if (existingIdx >= 0) {
          toolInvocations[existingIdx].state = 'result';
          toolInvocations[existingIdx].result = chunk.output;
        } else {
          toolInvocations.push({
            toolCallId: chunk.toolCallId,
            toolName: originalToolName,
            state: 'result',
            result: chunk.output,
          });
        }

        // Emit agent message as named SSE event (non-standard, Alia extension)
        if (originalToolName === 'delegateToAgent' && chunk.output && !chunk.output.error) {
          const ar = chunk.output;
          res.write(`event: alia.agent\ndata: ${JSON.stringify({
            eventVersion: 1,
            agentId: ar.agentId,
            agentName: ar.agentName,
            agentHandle: ar.agentHandle,
            agentAvatar: ar.agentAvatar,
            content: ar.response,
          })}\n\n`);
          agentMessages.push({
            role: 'assistant',
            content: ar.response,
            agentInfo: { id: ar.agentId, name: ar.agentName, avatar: ar.agentAvatar, handle: ar.agentHandle },
          });
        }
      } else if (chunk.type === 'tool-error') {
        // Handle tool execution errors
        ensureSSEHeaders();
        hasStreamedContent = true;

        const originalToolName = toolNameMapping.get((chunk as ExtendedChunk).toolName ?? '') || (chunk as ExtendedChunk).toolName;
        log.v1.error({ err: (chunk as ExtendedChunk).error, toolName: originalToolName }, 'Tool error');

        // Send tool error as text content so the user sees what happened
        const errorMessage = (chunk as ExtendedChunk).error?.message || 'Tool execution failed';
        const toolErrorContent = `\n\nTool error (${originalToolName}): ${errorMessage}`;
        writeContentChunk(res, requestId, aliasModelId, toolErrorContent);
        assistantResponse += toolErrorContent;
      } else if (chunk.type === 'start') {
        log.v1.debug('Stream started');
      } else if (chunk.type === 'start-step') {
        log.v1.debug('Step started');
      } else if (chunk.type === 'text-start' || chunk.type === 'text-end') {
        // Text generation lifecycle events - no action needed
      } else if (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-end' || chunk.type === 'tool-input-delta') {
        // Tool input streaming events - no action needed
      } else if (chunk.type === 'source' || chunk.type === 'file' || chunk.type === 'raw') {
        // Source/file/raw events - no action needed
      } else if (chunk.type === 'finish-step') {
        log.v1.debug('Step finished');
      } else if (chunk.type === 'error') {
        log.v1.error({ err: (chunk as ExtendedChunk).error }, 'Error chunk received');

        // Record failure for circuit breaker - classify error for accurate reporting
        const streamErrorReason = classifyError((chunk as ExtendedChunk).error);
        const streamRetryAfterSec = getRetryAfterHeader((chunk as ExtendedChunk).error);
        const streamRetryAfterMs = streamRetryAfterSec ? streamRetryAfterSec * 1000 : undefined;
        await reportModelUsage(resolved!.keyConfig?.keyId, resolved!.provider, resolved!.modelId, false, 0, streamErrorReason, streamRetryAfterMs);

        const rawError = (chunk as ExtendedChunk).error;

        // If no content streamed yet, throw to trigger provider fallback
        if (!hasStreamedContent) {
          log.v1.info({ provider: resolved!.provider, modelId: resolved!.modelId }, 'Stream error (no content sent), trying next provider');
          throw rawError;
        }

        // If only tool content was streamed (no text), retry synthesis with collected tool results
        if (!hasStreamedText && toolInvocations.some(t => t.state === 'result')) {
          log.v1.info({ provider: resolved!.provider, modelId: resolved!.modelId }, 'Synthesis failed after tool results, retrying without tools');
          try {
            const followUpMessages = [
              ...convertedMessages,
              ...toolInvocations
                .filter(t => t.state === 'result')
                .flatMap(t => [
                  { role: 'assistant' as const, content: '', toolCalls: [{ toolCallId: t.toolCallId, toolName: t.toolName, args: t.args }] },
                  { role: 'tool' as const, content: [{ type: 'tool-result' as const, toolCallId: t.toolCallId, toolName: t.toolName, output: { type: 'text' as const, value: typeof t.result === 'string' ? t.result : JSON.stringify(t.result) } }] },
                ]),
            ];

            // Fresh abort controller — the original may already be aborted
            const retryAbort = new AbortController();
            const retryTimer = setTimeout(() => retryAbort.abort(), 30_000);

            try {
              const retryResult = streamText({ ...baseConfig, abortSignal: retryAbort.signal, messages: followUpMessages, tools: undefined, stopWhen: undefined });

              for await (const retryChunk of retryResult.fullStream) {
                if (res.writableEnded) break;
                if (retryChunk.type === 'text-delta' && retryChunk.text) {
                  const filtered = writeTextChunk(res, requestId, aliasModelId, retryChunk.text);
                  if (filtered) {
                    hasStreamedText = true;
                    assistantResponse += filtered;
                  }
                }
              }
            } finally {
              clearTimeout(retryTimer);
            }

            if (hasStreamedText && !res.writableEnded) {
              writeStopChunk(res, requestId, aliasModelId);
              break; // Exit main stream loop — synthesis retry succeeded
            }
          } catch (retryErr) {
            log.v1.error({ err: retryErr }, 'Synthesis retry also failed');
          }
        }

        // Mid-stream graceful recovery: send a friendly message instead of raw error
        if (!hasStreamedText && !res.writableEnded) {
          ensureSSEHeaders();
          const midStreamMsg = isSpanish
            ? '\n\nHubo una breve interrupción. Por favor, envía tu mensaje de nuevo y completaré mi respuesta.'
            : '\n\nI encountered a brief interruption. Please send your message again and I\'ll complete my response.';
          writeContentChunk(res, requestId, aliasModelId, midStreamMsg);
          writeStopChunk(res, requestId, aliasModelId);
        }
      } else if (chunk.type === 'finish') {
        log.v1.debug('Finish chunk received');
        ensureSSEHeaders();
        writeStopChunk(res, requestId, aliasModelId, chunk.finishReason || 'stop');
      } else {
        log.v1.warn({ chunkType: chunk.type, chunk }, 'Unhandled chunk type');
      }
    }

    clearInterval(keepAliveTimer);
    log.v1.info({ totalChunks: chunkCount }, 'Stream processing complete');

    // ── Text-based tool call fallback ──
    // Some models (Gemini 3 preview, Minimax, etc.) output tool calls as text
    // instead of using the native tool calling API. Detect and execute them.

    let textToolCallIdx = 0;
    async function executeTextToolCall(toolName: string, args: unknown): Promise<boolean> {
      const toolFn = truncatedTools[toolName];
      if (!toolFn?.execute) {
        log.v1.warn({ toolName }, 'Text tool call references unknown tool, skipping');
        return false;
      }

      const toolCallId = `text-fallback-${Date.now()}-${textToolCallIdx++}-${toolName}`;

      // Emit tool-call event to client
      res.write(`data: ${JSON.stringify(makeChunk(requestId, aliasModelId, [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] },
        finish_reason: null,
      }]))}\n\n`);

      try {
        const toolOutput = await (toolFn.execute as (...args: unknown[]) => unknown)(args);

        res.write(`event: alia.tool_result\ndata: ${JSON.stringify({
          eventVersion: 1,
          tool_call_id: toolCallId,
          name: toolName,
          output: toolOutput,
        })}\n\n`);

        toolInvocations.push({ toolCallId, toolName, state: 'result', args, result: toolOutput });

        // Follow-up LLM call so the model generates a natural response
        try {
          const followUpMessages = [
            ...convertedMessages,
            { role: 'assistant', content: '', toolCalls: [{ toolCallId, toolName, args }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput) } }] },
          ];
          const followUpResult = streamText({ ...baseConfig, messages: followUpMessages, tools: undefined, stopWhen: undefined, onFinish: undefined });

          for await (const followUpChunk of followUpResult.fullStream) {
            if (followUpChunk.type === 'text-delta' && followUpChunk.text) {
              const followUpText = writeTextChunk(res, requestId, aliasModelId, followUpChunk.text);
              if (followUpText) {
                assistantResponse = followUpText;
              }
            }
          }
        } catch (followUpErr) {
          log.v1.error({ err: followUpErr }, 'Error in text-tool-call follow-up LLM call');
        }
      } catch (toolErr) {
        log.v1.error({ err: toolErr, toolName }, 'Error executing text-based tool call');
        return false;
      }
      return true;
    }

    const TEXT_TOOL_CALL_RE = /<function\((\w+)\)>\s*<?\s*(\{[\s\S]*?\})\s*>?\s*<\/function>/g;

    if (assistantResponse && toolInvocations.length === 0) {
      // Format 1: <function(name)>{json}</function>
      const textToolMatches = [...assistantResponse.matchAll(TEXT_TOOL_CALL_RE)];
      if (textToolMatches.length > 0) {
        log.v1.warn({ matchCount: textToolMatches.length, format: 'xml', provider: resolved!.provider, modelId: resolved!.modelId }, 'Detected text-based tool calls — executing fallback');
        for (const match of textToolMatches) {
          let args: unknown;
          try { args = JSON.parse(match[2]); } catch { continue; }
          await executeTextToolCall(match[1], args);
        }
        assistantResponse = assistantResponse.replace(TEXT_TOOL_CALL_RE, '').trim();
      }

      // Format 2: entire response is a JSON tool call (OpenAI format)
      if (toolInvocations.length === 0) {
        try {
          const parsed = JSON.parse(assistantResponse.trim());
          if (parsed?.type === 'function' && typeof parsed.name === 'string' && parsed.parameters) {
            log.v1.warn({ format: 'openai-json', toolName: parsed.name, provider: resolved!.provider, modelId: resolved!.modelId }, 'Detected JSON tool call in text response — executing fallback');
            await executeTextToolCall(parsed.name, parsed.parameters);
            assistantResponse = '';
          }
        } catch { /* not JSON — no action needed */ }
      }
    }

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

    if (keepAliveTimer) clearInterval(keepAliveTimer);
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
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      // Provider attempt failed — classify with shared error classifier
      log.v1.error({ err: providerError, provider: resolved!.provider, modelId: resolved!.modelId }, 'Provider failed');
      const errorReason = classifyError(providerError);
      const retryAfterSec = getRetryAfterHeader(providerError);
      const retryAfterMs = retryAfterSec ? retryAfterSec * 1000 : undefined;
      await reportModelUsage(resolved!.keyConfig?.keyId, resolved!.provider, resolved!.modelId, false, 0, errorReason, retryAfterMs);

      // Non-retryable errors: stop immediately (would fail on any provider)
      if (NON_RETRYABLE_STREAM.has(errorReason)) {
        if (hasStreamedContent) throw providerError;
        break; // Fall through to last-resort response
      }

      // If content already streamed, can't retry — fall to outer handler
      if (hasStreamedContent) {
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

    if (!sseHeadersSent && !res.headersSent) {
      // Non-streaming: return standard JSON response
      res.json({
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: aliasModelId,
        system_fingerprint: 'fp_alia',
        service_tier: 'default',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: syntheticMessage, refusal: null },
          logprobs: null,
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        },
        alia_meta: { synthetic: true, retryable: true },
      });
    } else {
      // Streaming: send synthetic message as normal SSE chunks
      ensureSSEHeaders();
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
