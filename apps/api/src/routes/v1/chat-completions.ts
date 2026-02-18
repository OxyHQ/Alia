import { Router, Request, Response } from 'express';
import { streamText, generateText, stepCountIs, type ToolSet } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel, reportModelUsage } from '../../lib/chat-core.js';
import { getAliaModel, getModelMappingsForTier } from '../../lib/providers-client.js';
import { UserMemory } from '../../models/user-memory.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { saveConversation } from '../../lib/conversation-saver.js';
import { reserveCredits, finalizeCredits, refundReservation, type CreditReservation, type CreditUsage } from '../../lib/credits-manager.js';
import { recordUsage } from '../../middleware/api-key-rate-limit.js';
import { detectCreditAnomaly } from '../../lib/credit-anomaly.js';
import { getUserEntitlements } from '../../lib/plan-access.js';
import { convertOpenAIToolsToToolSet } from '../../lib/tool-converter.js';
import { getCurrentDateTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createSendTelegramTool, createGetWhatsAppChatsTool, createGetWhatsAppMessagesTool, createSendWhatsAppMessageTool, createProvidersAdminTool, webScraperTool, generateFileTool, createSearchAgentsTool, createDelegateToAgentTool } from '../../lib/tools/index.js';
import { oxyClient } from '../../middleware/auth.js';
import type { KeyConfig } from '../../lib/providers-client.js';
import type { IUserMemory } from '../../models/user-memory.js';
import { Skill } from '../../models/skill.js';
import { estimateMessageTokens } from '../../lib/token-counter.js';
import { runAfterChatHooks } from '../../lib/hooks/index.js';
import { buildSystemPrompt } from '../../lib/prompt-loader.js';
import { wrapToolsWithTruncation, getToolResultBudget } from '../../lib/tools/result-truncation.js';
import { log } from '../../lib/logger.js';
import { recordEvent } from '../../lib/observability/index.js';
// recordFailure is now handled via reportModelUsage from chat-core

const router = Router();

/**
 * Classify a provider error into a clean reason string for cooldown/circuit breaker logic.
 * The AI SDK wraps errors inconsistently — .code might be missing or generic.
 */
function classifyProviderError(error: unknown): string {
  const status = (error as any)?.status || (error as any)?.statusCode;
  const code = String((error as any)?.code || '');
  const msg = String((error as any)?.message || '').toLowerCase();
  const combined = `${code} ${msg}`;

  if (status === 429 || /rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(combined)) return 'rate_limit';
  if (status === 401 || status === 403 || /unauthorized|invalid.*key/i.test(msg)) return 'auth';
  if (/timeout|ETIMEDOUT|abort/i.test(combined)) return 'timeout';
  if (status === 503 || status === 529 || /overload|capacity/i.test(msg)) return 'overloaded';
  return 'unknown';
}

/**
 * Check if an error is retryable (rate limit, overloaded, etc.)
 * Used to decide whether to try the next provider in the tier.
 */
function isRetryableError(error: unknown): boolean {
  const reason = classifyProviderError(error);
  return reason === 'rate_limit' || reason === 'overloaded' || reason === 'timeout';
}

/**
 * Convert OpenAI-format messages to AI SDK ModelMessage format.
 * Handles tool result messages which have role "tool" in OpenAI format.
 */
function convertToAISDKMessages(messages: any[], toolNameMapping: Map<string, string>): any[] {
  const result: any[] = [];
  const toolCallsMap = new Map<string, { name: string; index: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'system') {
      result.push({
        role: 'system',
        content: msg.content || ''
      });
    } else if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        // Multi-part content (text + images): convert OpenAI image_url format to AI SDK image format
        result.push({
          role: 'user',
          content: msg.content.map((part: any) => {
            if (part.type === 'image_url' && part.image_url?.url) {
              return { type: 'image', image: part.image_url.url };
            }
            return part;
          }),
        });
      } else {
        result.push({
          role: 'user',
          content: msg.content
        });
      }
    } else if (msg.role === 'assistant') {
      // Support both formats:
      // - tool_calls: OpenAI/editor format (from Cursor, VS Code, etc.)
      // - toolInvocations: Alia app format (from mobile/web app)
      let toolCalls = msg.tool_calls;
      if (!toolCalls && msg.toolInvocations && Array.isArray(msg.toolInvocations) && msg.toolInvocations.length > 0) {
        toolCalls = msg.toolInvocations.map((inv: any) => ({
          id: inv.toolCallId,
          type: 'function',
          function: {
            name: inv.toolName,
            arguments: JSON.stringify(inv.args || {}),
          },
        }));
      }

      if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
        // Track tool calls for matching with results
        for (const tc of toolCalls) {
          if (tc.id && tc.function?.name) {
            const sanitizedName = Array.from(toolNameMapping.entries())
              .find(([_, orig]: [string, string]) => orig === tc.function.name)?.[0] || tc.function.name;
            toolCallsMap.set(tc.id, { name: sanitizedName, index: result.length });
          }
        }

        result.push({
          role: 'assistant',
          content: msg.content || '',
          toolCalls: toolCalls.map((tc: any) => {
            const sanitizedName = Array.from(toolNameMapping.entries())
              .find(([_, orig]: [string, string]) => orig === tc.function?.name)?.[0] || tc.function?.name || 'unknown';

            return {
              toolCallId: tc.id,
              toolName: sanitizedName,
              args: typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments || {})
            };
          })
        });

        // For toolInvocations with results, also push corresponding tool result messages
        // (These are already resolved — the app stores the tool output inline)
        if (msg.toolInvocations && Array.isArray(msg.toolInvocations)) {
          for (const inv of msg.toolInvocations) {
            if (inv.state === 'result' && inv.result !== undefined) {
              const resultValue = typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result);
              result.push({
                role: 'tool',
                content: [{
                  type: 'tool-result',
                  toolCallId: inv.toolCallId,
                  toolName: inv.toolName,
                  output: {
                    type: 'text',
                    value: resultValue,
                  },
                }],
              });
            }
          }
        }
      } else {
        result.push({
          role: 'assistant',
          content: msg.content || ''
        });
      }
    } else if (msg.role === 'tool') {
      // Convert OpenAI tool result to AI SDK format
      const toolCallId = msg.tool_call_id;
      const toolInfo = toolCallsMap.get(toolCallId);
      let toolName = toolInfo?.name || msg.name || 'unknown';

      // Try to find tool name from previous assistant message if unknown
      if (toolName === 'unknown' && i > 0) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            const matchingCall = prevMsg.tool_calls.find((tc: any) => tc.id === toolCallId);
            if (matchingCall) {
              toolName = matchingCall.function?.name || 'unknown';
              break;
            }
          }
        }
      }

      const contentValue = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      result.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: toolCallId,
          toolName: toolName,
          output: {
            type: 'text',
            value: contentValue
          }
        }]
      });
    }
  }

  return result;
}

// getAIModel is now imported from chat-core.ts

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint with streaming support
 */
router.post('/', async (req: Request, res: Response) => {
  let creditReservation: CreditReservation | null = null;
  let resolved: Awaited<ReturnType<typeof resolveModel>> = null;
  let aliasModelId: string = 'alia-v1';
  const requestStartTime = Date.now();

  // Global request timeout guard — send a proper error BEFORE DO's gateway timeout (~120s)
  const GLOBAL_TIMEOUT_MS = 80_000;
  let globalTimedOut = false;
  const globalTimer = setTimeout(() => {
    globalTimedOut = true;
    if (!res.headersSent) {
      log.v1.error('Global request timeout after 80s');
      res.status(503).json({ error: 'Request timeout', message: 'The request took too long. Please try again.' });
    }
  }, GLOBAL_TIMEOUT_MS);

  try {
    log.v1.info('Request received');
    const body = req.body;

    // Validate request body
    if (!body || typeof body !== 'object') {
      res.status(400).json({
        error: 'Invalid request body',
        details: 'Request body must be a JSON object'
      });
      return;
    }

    // Support both "messages" (OpenAI standard) and "input" (Cursor format)
    const messages = body.messages || body.input;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: 'Invalid messages',
        details: 'Request body must include a "messages" array with at least one message'
      });
      return;
    }

    // Extract optional parameters for Alia internal features
    const conversationId = body.conversationId as string | undefined;
    const thinkingMode = body.thinkingMode as boolean | undefined;
    const agentMode = body.agentMode as boolean | undefined;

    log.v1.info({ messageCount: messages.length, conversationId, thinkingMode, agentMode }, 'Processing messages');

    // Determine if this is a direct user session (not API key)
    // API key requests should be neutral and not include creator's personal info
    const isDirectUserSession = req.user && !req.apiKey;
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
      const chunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: aliasModelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
        error: errorPayload,
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }

    // --- PARALLEL PRE-STREAMING OPERATIONS ---
    // Run independent operations concurrently to reduce time-to-first-token
    const preStreamStart = Date.now();

    const [creditResult, resolvedResult, userMemory, oxyUser, skill, entitlements] = await Promise.all([
      // Credits: sequential pair (getOrCreate → reserve), parallel with everything else
      req.user ? (async () => {
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
            (oxyClient.getUserById(req.user!.id) as Promise<any>),
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
    ]);

    log.v1.info({ durationMs: Date.now() - preStreamStart }, 'Pre-stream setup complete');

    // Validate credit reservation
    // Only return 402 if reserveCredits explicitly returned null (insufficient credits),
    // not if there was a DB error (original behavior: continue without credits on error)
    creditReservation = creditResult.reservation;
    if (req.user && !creditReservation && !creditResult.error) {
      clearTimeout(globalTimer);
      const creditError = {
        code: 'INSUFFICIENT_CREDITS',
        message: "You've run out of credits. Add more or upgrade your plan to continue.",
        retryable: false,
        suggestedAction: 'upgrade',
        status: 402,
        details: { limitType: 'credits' },
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
      if (earlySSE) {
        sendSSEError({ code: 'NO_MODELS', message: 'No models available. Please try again.', status: 503 });
      } else {
        res.status(503).json({ error: 'No models available', requested_model: requestedModel });
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
          code: 'MODEL_NOT_IN_PLAN',
          message: 'Upgrade your plan to use this model.',
          retryable: false,
          suggestedAction: 'upgrade',
          status: 403,
          details: { model: aliasModelId },
        };
        if (earlySSE) {
          sendSSEError(modelError);
        } else {
          res.status(403).json({ error: modelError });
        }
        return;
      }
    }

    // Build system prompt (depends on aliasModelId from model resolution)
    const baseSystemPrompt = await buildSystemPrompt(aliasModelId, clientContext);

    // Convert editor tools from OpenAI format and sanitize names for Google compatibility
    const toolNameMapping = new Map<string, string>();
    const editorTools = Array.isArray(body.tools) ? convertOpenAIToolsToToolSet(body.tools, toolNameMapping) : {};

    // Alia internal tools are server-executed
    // Editor tools are client-executed (VS Code, Cursor, Cowork)
    const hasEditorTools = Object.keys(editorTools).length > 0;

    // Always include server-only tools (no conflicts with client tools):
    // - getCurrentDate: Server time/date
    // - sendTelegram: Server-side Telegram API (only for direct user sessions)
    // - saveUserMemory/updateUserPreferences/updateUserContext: Server-side DB operations (only for direct user sessions)
    //
    // IMPORTANT: Memory tools are ONLY available for direct user sessions.
    // API key requests should NOT be able to modify the API creator's memory.
    //
    const aliaTools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      webScraper: webScraperTool,
      generateFile: generateFileTool,
      // Personal tools only available for direct user sessions (not API key requests)
      ...(isDirectUserSession ? {
        sendTelegram: createSendTelegramTool(req.user!.id),
        getWhatsAppChats: createGetWhatsAppChatsTool(req.user!.id),
        getWhatsAppMessages: createGetWhatsAppMessagesTool(req.user!.id),
        sendWhatsAppMessage: createSendWhatsAppMessageTool(req.user!.id),
        saveUserMemory: saveUserMemoryTool(req.user!.id),
        updateUserPreferences: updateUserPreferencesTool(req.user!.id),
        updateUserContext: updateUserContextTool(req.user!.id),
      } : {}),
    };

    const allTools = { ...aliaTools, ...editorTools };

    // Agent mode: add search & delegation tools
    const agentMessages: Array<{ role: 'assistant'; content: string; agentInfo: { id: string; name: string; avatar: string | null; handle: string } }> = [];
    if (agentMode && isDirectUserSession) {
      allTools.searchAgents = createSearchAgentsTool();
      allTools.delegateToAgent = createDelegateToAgentTool();
    }

    // Log tool schemas for debugging
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      log.v1.info({ toolCount: body.tools.length }, 'Received tools from client');
    }

    // Build system message from base prompt (which includes language + identity + tool boundaries)
    // Only add a language preference fallback if the user has one saved
    const userLanguagePreference = isDirectUserSession ? userMemory?.preferences?.language : undefined;
    let systemMessage = baseSystemPrompt;
    if (userLanguagePreference) {
      systemMessage += `\n\nThe user's default language is ${userLanguagePreference}, but ONLY use this when the language of their message is truly ambiguous or impossible to detect. If the user writes in any identifiable language, always respond in that language.`;
    }

    // Inject current model identity so Alia knows which tier it's running as
    const aliaModel = await getAliaModel(aliasModelId);
    if (aliaModel) {
      systemMessage += `\n\nYou are currently using the **${aliaModel.name}** model. When asked what model you use, say you are using ${aliaModel.name}.`;
    }

    // Only inject personal user information for DIRECT user sessions
    // API key requests are for third-party apps and should remain neutral
    if (isDirectUserSession) {
      // Use user profile fetched in parallel
      const userName = oxyUser?.name?.full || oxyUser?.name?.first || oxyUser?.username;
      if (userName) {
        systemMessage += `\n\nThe user's name is ${userName}.`;
      }
      // Add admin tools for authorized users
      if (oxyUser?.username === 'nate') {
        allTools.providersAdmin = createProvidersAdminTool();
      }
      systemMessage += '\n\nYou have `sendTelegram` and WhatsApp tools (`getWhatsAppChats`, `getWhatsAppMessages`, `sendWhatsAppMessage`). Use them when the user asks. For WhatsApp, call getWhatsAppChats first to get chat JIDs.';
      if (agentMode) {
        systemMessage += '\n\nAGENT MODE: You have `searchAgents` and `delegateToAgent` tools. Search for specialist agents, delegate to the best match, and briefly explain why. If no agent fits, handle it yourself.';
      }
    } else if (req.apiKey) {
      // API key request - add neutral context
      log.v1.info('API key request - using neutral context');
    }

    // Only inject user memory for DIRECT user sessions
    // API key requests should not have access to the API creator's personal memory
    if (userMemory && isDirectUserSession) {
      systemMessage += '\n\n## User Information';

      if (userMemory.memories && userMemory.memories.length > 0) {
        systemMessage += '\n### Known Facts:\n' + userMemory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
      }
      if (userMemory.preferences && Object.keys(userMemory.preferences).length > 0) {
        const prefs = Object.entries(userMemory.preferences)
          .filter(([k, v]) => v !== undefined && v !== null && k !== 'language')
          .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        if (prefs.length > 0) {
          systemMessage += '\n### User Preferences:\n' + prefs.join('\n');
        }
      }
      if (userMemory.context && Object.keys(userMemory.context).length > 0) {
        const ctx = Object.entries(userMemory.context)
          .filter(([_, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `- ${k}: ${v}`);
        if (ctx.length > 0) {
          systemMessage += '\n### Context:\n' + ctx.join('\n');
        }
      }
    }

    // Inject skill system prompt if skillId provided (already loaded in parallel)
    if (skill && (skill as any).systemPrompt && isDirectUserSession) {
      systemMessage = `# ACTIVE SKILL: ${(skill as any).title}\n\n${(skill as any).systemPrompt}\n\n---\n\n${systemMessage}`;
      log.v1.info({ skillTitle: (skill as any).title }, 'Skill activated');
    }

    // Title generation instruction (only for direct user sessions in the app, not API keys or voice)
    if (isDirectUserSession) {
      systemMessage += '\n\nEnd every response with `[ALIA_TITLE]Short Title[/ALIA_TITLE]` (max 6 words, in the response language).';
    }

    // Brief language reminder at the end (recency effect)
    systemMessage += '\n\nRemember: respond in the same language the user writes to you.';

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
    const modelContextTokens = tierMappings[0]?.capabilities?.maxContextTokens || 128000;
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
    // When a provider returns 429/rate-limit, try the next provider in the tier
    const MAX_PROVIDER_RETRIES = 3;
    const skipProviders = new Set<string>();
    let sseHeadersSent = earlySSE;

    /** Set SSE headers if not already sent (idempotent). */
    function ensureSSEHeaders() {
      if (!sseHeadersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        sseHeadersSent = true;
      }
    }

    for (let providerAttempt = 0; providerAttempt < MAX_PROVIDER_RETRIES; providerAttempt++) {
    // Check global timeout before each provider attempt
    if (globalTimedOut) break;

    // Re-resolve model on retry (skipping failed providers)
    if (providerAttempt > 0) {
      resolved = await resolveModel(requestedModel, skipProviders);
      if (!resolved) {
        log.v1.warn({ retries: providerAttempt }, 'No more providers available after retries');
        break;
      }
      aliasModelId = resolved.aliasModelId;
      log.v1.info({ attempt: providerAttempt, provider: resolved.provider, modelId: resolved.modelId }, 'Retrying with provider');
    }

    const model = getAIModel(resolved!.keyConfig);

    // Build common config for both streaming and non-streaming
    const baseConfig: any = {
      model,
      messages: convertedMessages,
      temperature: body.temperature ?? 0.7,
      tools: truncatedTools,
      maxRetries: 0, // Fail fast to application-level provider fallback
      // AI SDK v6: stopWhen replaces maxSteps. Without this, the SDK defaults to
      // stepCountIs(1) which stops after tool calls without generating a text response.
      stopWhen: stepCountIs(5),
      onFinish: async (result: any) => {
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
    const providerMetadata: any = {};

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

      // Auto-save conversation if conversationId provided and user is authenticated
      if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user && assistantResponse) {
        try {
          await saveConversation({
            userId: req.user.id,
            conversationId,
            messages,
            assistantResponse,
            toolInvocations: nonStreamToolInvocations,
          });
          log.v1.info({ conversationId }, 'Conversation saved');
        } catch (error) {
          log.v1.error({ err: error }, 'Error saving conversation');
        }
      }

      // Finalize credits
      let creditsCharged = 0;
      let creditsRemaining = 0;
      if (creditReservation && req.user) {
        try {
          const creditResult = await finalizeCredits(creditReservation, tokenUsage, aliasModelId);
          creditsCharged = creditResult.creditsCharged;
          creditsRemaining = creditResult.creditsRemaining;

          // Record usage with credits info (API key basic usage is also logged in auth middleware)
          recordUsage(req, 200, tokenUsage.totalTokens, undefined, creditsCharged).catch(err =>
            log.v1.error({ err }, 'Error recording session usage')
          );
        } catch (error) {
          log.v1.error({ err: error }, 'Error finalizing credits');
        }
      }

      // Fire afterChat hooks (non-blocking)
      runAfterChatHooks({
        userId: req.user?.id,
        conversationId: body.conversationId,
        messages,
        model: aliasModelId,
        skillId: body.skillId,
        platform: req.apiKey ? 'telegram' as const : 'app' as const,
        metadata: { provider: resolved?.provider || 'unknown' },
        response: assistantResponse,
        tokenUsage,
        modelUsed: resolved?.keyConfig?.modelId || aliasModelId,
        latencyMs: Date.now() - requestStartTime,
      }).catch(err => log.v1.error({ err }, 'Error in afterChat hooks'));

      // Build tool_calls array if there were any tool calls
      const toolCalls = result.toolCalls?.map((tc: any, index: number) => {
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
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: aliasModelId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: assistantResponse,
            ...(toolCalls && toolCalls.length > 0 && { tool_calls: toolCalls })
          },
          finish_reason: result.finishReason || 'stop'
        }],
        usage: {
          prompt_tokens: tokenUsage.promptTokens,
          completion_tokens: tokenUsage.completionTokens,
          total_tokens: tokenUsage.totalTokens,
          system_prompt_tokens: tokenUsage.systemPromptTokens || 0,
          billable_tokens: Math.max(0, tokenUsage.totalTokens - (tokenUsage.systemPromptTokens || 0)),
          credits_charged: creditsCharged,
          credits_remaining: creditsRemaining,
          credit_warning: null as any,
        }
      };

      // Detect spending anomalies for proactive warnings
      if (req.user?.id) {
        try {
          const warning = await detectCreditAnomaly(req.user.id);
          if (warning) {
            warning.currentModelMultiplier = (await getAliaModel(aliasModelId))?.creditMultiplier || 1;
          }
          response.usage.credit_warning = warning;
        } catch {}
      }

      res.json(response);
      clearTimeout(globalTimer);
      return;
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

    // Stream OpenAI-compatible chunks
    log.v1.info('Starting to process AI SDK stream');
    let chunkCount = 0;
    let assistantResponse = ''; // Track assistant's response for conversation save
    const toolInvocations: Array<{ toolCallId: string; toolName: string; state: 'call' | 'result'; args?: any; result?: any }> = [];
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

        // Extract <thinking> tags for chain-of-thought (Anthropic, DeepSeek, etc.)
        const thinkingMatch = chunk.text.match(/<thinking>([\s\S]*?)<\/thinking>/g);
        if (thinkingMatch) {
          // Send thinking content as reasoning chunk
          thinkingMatch.forEach(match => {
            const content = match.replace(/<\/?thinking>/g, '').trim();
            if (content) {
              const reasoningChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: aliasModelId,
                choices: [{
                  index: 0,
                  delta: {
                    reasoning: content,
                    role: 'assistant'
                  },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
              log.v1.debug({ reasoning: content.slice(0, 100) }, 'Reasoning chunk (thinking tag)');
            }
          });
        }

        // Filter out thinking tags from the main message
        const filtered = chunk.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
        if (filtered) {
          assistantResponse += filtered; // Accumulate response for conversation save
          const openAIChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: aliasModelId,
            choices: [{
              index: 0,
              delta: { content: filtered },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
        }
      } else if ((chunk as any).type === 'thought-delta' || (chunk as any).type === 'reasoning-delta') {
        ensureSSEHeaders();
        hasStreamedContent = true;

        // Handle Gemini thought summaries and other reasoning tokens
        const reasoningText = (chunk as any).text || (chunk as any).thoughtDelta || (chunk as any).reasoningDelta;
        if (reasoningText && typeof reasoningText === 'string' && reasoningText.trim()) {
          const reasoningChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: aliasModelId,
            choices: [{
              index: 0,
              delta: {
                reasoning: reasoningText.trim(),
                role: 'assistant'
              },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
          log.v1.debug({ reasoning: reasoningText.slice(0, 100) }, 'Reasoning chunk (provider)');
        }
      } else if (chunk.type === 'tool-call') {
        ensureSSEHeaders();
        hasStreamedContent = true;

        // Restore original tool name if it was sanitized
        const originalToolName = toolNameMapping.get(chunk.toolName) || chunk.toolName;

        // Log the tool call arguments being sent to the client
        log.v1.info({ toolName: originalToolName, args: chunk.input }, 'Streaming tool call');

        const toolCallChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: chunk.toolCallId,
                type: 'function',
                function: {
                  name: originalToolName,
                  arguments: JSON.stringify(chunk.input || {})
                }
              }]
            },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);

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

        // Stream tool result to the client
        const toolResultChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: {
              tool_result: {
                tool_call_id: chunk.toolCallId,
                name: originalToolName,
                output: chunk.output,
              }
            },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(toolResultChunk)}\n\n`);

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

        // Emit agent_message SSE event when delegateToAgent returns successfully
        if (originalToolName === 'delegateToAgent' && chunk.output && !chunk.output.error) {
          const ar = chunk.output;
          const agentChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: aliasModelId,
            choices: [{
              index: 0,
              delta: {
                agent_message: {
                  agentId: ar.agentId,
                  agentName: ar.agentName,
                  agentHandle: ar.agentHandle,
                  agentAvatar: ar.agentAvatar,
                  content: ar.response,
                },
              },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(agentChunk)}\n\n`);
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

        const originalToolName = toolNameMapping.get((chunk as any).toolName) || (chunk as any).toolName;
        log.v1.error({ err: (chunk as any).error, toolName: originalToolName }, 'Tool error');

        // Send tool error as text content so the user sees what happened
        const errorMessage = (chunk as any).error?.message || 'Tool execution failed';
        const errorChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: { content: `\n\n⚠️ Tool error (${originalToolName}): ${errorMessage}` },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        assistantResponse += `\n\n⚠️ Tool error (${originalToolName}): ${errorMessage}`;
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
        log.v1.error({ err: (chunk as any).error }, 'Error chunk received');

        // Record failure for circuit breaker - next request will use different provider
        await reportModelUsage(resolved!.keyConfig?.keyId, resolved!.provider, resolved!.modelId, false, 0, (chunk as any).error?.code || 'STREAM_ERROR');

        const rawError = (chunk as any).error;

        // If no content streamed yet, throw to trigger provider fallback
        if (!hasStreamedContent) {
          log.v1.info({ provider: resolved!.provider, modelId: resolved!.modelId }, 'Stream error (no content sent), trying next provider');
          throw rawError;
        }

        // CRITICAL: Translate error to remove provider information!
        const { translateError, sanitizeMessage } = await import('../../lib/error-handler.js');
        const aliaError = translateError(rawError, resolved!.provider, resolved!.modelId);

        ensureSSEHeaders();

        const errorChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: {
              content: `\n\n⚠️ Error: ${sanitizeMessage(aliaError.userMessage)}`
            },
            finish_reason: 'error'
          }]
        };
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      } else if (chunk.type === 'finish') {
        log.v1.debug('Finish chunk received');
        ensureSSEHeaders();
        const finishChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: chunk.finishReason || 'stop'
          }]
        };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
      } else {
        log.v1.warn({ chunkType: chunk.type, chunk }, 'Unhandled chunk type');
      }
    }

    clearInterval(keepAliveTimer);
    log.v1.info({ totalChunks: chunkCount }, 'Stream processing complete');

    // ── Text-based tool call fallback ──
    // Some models (Gemini 3 preview, Minimax, etc.) output tool calls as text
    // instead of using the native tool calling API. Detect and execute them.
    const TEXT_TOOL_CALL_RE = /<function\((\w+)\)>\s*<?\s*(\{[\s\S]*?\})\s*>?\s*<\/function>/g;
    if (assistantResponse && toolInvocations.length === 0) {
      const textToolMatches = [...assistantResponse.matchAll(TEXT_TOOL_CALL_RE)];
      if (textToolMatches.length > 0) {
        log.v1.warn({ matchCount: textToolMatches.length, provider: resolved!.provider, modelId: resolved!.modelId }, 'Detected text-based tool calls — executing fallback');

        for (const match of textToolMatches) {
          const toolName = match[1];
          const toolFn = truncatedTools[toolName];
          if (!toolFn?.execute) {
            log.v1.warn({ toolName }, 'Text tool call references unknown tool, skipping');
            continue;
          }

          let args: any;
          try {
            args = JSON.parse(match[2]);
          } catch {
            log.v1.warn({ toolName, raw: match[2] }, 'Failed to parse text tool call arguments');
            continue;
          }

          const toolCallId = `text-fallback-${Date.now()}-${toolName}`;

          // Emit tool-call event to client
          const toolCallChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: aliasModelId,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);

          // Execute the tool
          try {
            const toolOutput = await (toolFn.execute as Function)(args);

            // Emit tool-result event to client
            const toolResultChunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: aliasModelId,
              choices: [{ index: 0, delta: { tool_result: { tool_call_id: toolCallId, name: toolName, output: toolOutput } }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(toolResultChunk)}\n\n`);

            toolInvocations.push({ toolCallId, toolName, state: 'result', args, result: toolOutput });

            // Make a follow-up LLM call with the tool result so the model can generate a real response
            try {
              const followUpMessages = [
                ...convertedMessages,
                { role: 'assistant', content: '', toolCalls: [{ toolCallId, toolName, args }] },
                { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput) } }] },
              ];
              const followUpResult = streamText({ ...baseConfig, messages: followUpMessages, tools: undefined, stopWhen: undefined });

              for await (const followUpChunk of followUpResult.fullStream) {
                if (followUpChunk.type === 'text-delta' && followUpChunk.text) {
                  const followUpText = followUpChunk.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
                  if (followUpText) {
                    assistantResponse = followUpText; // Replace the text-based tool call text
                    const textChunk = {
                      id: `chatcmpl-${Date.now()}`,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: aliasModelId,
                      choices: [{ index: 0, delta: { content: followUpText }, finish_reason: null }],
                    };
                    res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
                  }
                }
              }
            } catch (followUpErr) {
              log.v1.error({ err: followUpErr }, 'Error in text-tool-call follow-up LLM call');
            }
          } catch (toolErr) {
            log.v1.error({ err: toolErr, toolName }, 'Error executing text-based tool call');
          }
        }

        // Strip the raw text tool calls from the response for saving
        assistantResponse = assistantResponse.replace(TEXT_TOOL_CALL_RE, '').trim();
      }
    }

    // Auto-save conversation if conversationId provided and user is authenticated
    // Save when there's text content OR tool invocations (tools without text are valid responses)
    if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user && (assistantResponse || toolInvocations.length > 0)) {
      try {
        await saveConversation({
          userId: req.user.id,
          conversationId,
          messages,
          assistantResponse,
          toolInvocations,
          agentMessages: agentMessages.length > 0 ? agentMessages : undefined,
        });
        log.v1.info({ conversationId }, 'Conversation saved');
      } catch (error) {
        log.v1.error({ err: error }, 'Error saving conversation');
      }
    }

    // Finalize credits based on actual token usage and model tier
    if (creditReservation && req.user) {
      try {
        const { creditsCharged, creditsRemaining } = await finalizeCredits(
          creditReservation,
          tokenUsage,
          aliasModelId
        );

        // Record usage with credits info
        recordUsage(req, 200, tokenUsage.totalTokens, undefined, creditsCharged).catch(err =>
          log.v1.error({ err }, 'Error recording session usage')
        );

        // Detect spending anomalies for proactive warnings
        let creditWarning: any = null;
        if (req.user?.id) {
          try {
            creditWarning = await detectCreditAnomaly(req.user.id);
            if (creditWarning) {
              creditWarning.currentModelMultiplier = (await getAliaModel(aliasModelId))?.creditMultiplier || 1;
            }
          } catch {}
        }

        // Send usage info as metadata chunk (must include choices array for SDK compatibility)
        const usageChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: null
          }],
          usage: {
            prompt_tokens: tokenUsage.promptTokens,
            completion_tokens: tokenUsage.completionTokens,
            total_tokens: tokenUsage.totalTokens,
            system_prompt_tokens: tokenUsage.systemPromptTokens || 0,
            billable_tokens: Math.max(0, tokenUsage.totalTokens - (tokenUsage.systemPromptTokens || 0)),
            credits_charged: creditsCharged,
            credits_remaining: creditsRemaining,
            credit_warning: creditWarning,
          }
        };
        res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
      } catch (error) {
        log.v1.error({ err: error }, 'Error finalizing credits');
      }
    }

    // Fire afterChat hooks (non-blocking)
    runAfterChatHooks({
      userId: req.user?.id,
      conversationId: body.conversationId,
      messages,
      model: aliasModelId,
      skillId: body.skillId,
      platform: req.apiKey ? 'telegram' as const : 'app' as const,
      metadata: { provider: resolved?.provider || 'unknown' },
      response: assistantResponse,
      tokenUsage,
      modelUsed: resolved?.keyConfig?.modelId || aliasModelId,
      latencyMs: Date.now() - requestStartTime,
    }).catch(err => log.v1.error({ err }, 'Error in afterChat hooks'));

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
    res.write('data: [DONE]\n\n');
    res.end();
    clearTimeout(globalTimer);
    return; // Success - exit the route handler

    } catch (providerError: unknown) {
      // Clean up timers on provider failure
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      // Provider attempt failed
      log.v1.error({ err: providerError, provider: resolved!.provider, modelId: resolved!.modelId }, 'Provider failed');
      const errorReason = classifyProviderError(providerError);
      await reportModelUsage(resolved!.keyConfig?.keyId, resolved!.provider, resolved!.modelId, false, 0, errorReason);

      // If we haven't streamed content yet, try next provider (any error is retryable pre-content)
      if (!hasStreamedContent && providerAttempt < MAX_PROVIDER_RETRIES - 1) {
        log.v1.info({ provider: resolved!.provider }, 'Provider failed, trying next provider');
        skipProviders.add(resolved!.provider);
        continue; // Try next provider
      }

      // Non-retryable error, already streamed content, or last attempt - throw to outer handler
      throw providerError;
    }

    } // End of provider retry loop

    // If we get here, all providers were exhausted (resolved was null in the loop)
    clearTimeout(globalTimer);
    if (!res.headersSent) {
      res.status(503).json({ error: 'All providers exhausted', requested_model: requestedModel });
    } else if (sseHeadersSent) {
      // SSE headers already sent — send error as SSE chunk
      const errorChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: aliasModelId,
        choices: [{ index: 0, delta: { content: '\n\n⚠️ All models are currently unavailable. Please try again.' }, finish_reason: 'error' }]
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }

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
    const { translateError, formatErrorResponse, sanitizeMessage } = await import('../../lib/error-handler.js');
    const aliaError = translateError(e, resolved?.provider, resolved?.modelId);

    if (!res.headersSent) {
      res.status(aliaError.retryable ? 503 : 500).json(formatErrorResponse(aliaError));
    } else {
      // Headers already sent (streaming started), send error as SSE chunk
      const errorChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: aliasModelId,
        choices: [{
          index: 0,
          delta: {
            content: `\n\n⚠️ Error: ${sanitizeMessage(aliaError.userMessage)}`
          },
          finish_reason: 'error'
        }]
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

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
