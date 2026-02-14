import { Router, Request, Response } from 'express';
import { streamText, generateText, stepCountIs, type ToolSet } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel, reportModelUsage } from '../../lib/chat-core.js';
import { getAliaModel } from '../../internal/providers/lib/alia-models.js';
import { UserMemory } from '../../models/user-memory.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { Conversation } from '../../models/conversation.js';
import { reserveCredits, finalizeCredits, type CreditReservation, type CreditUsage } from '../../lib/credits-manager.js';
import { recordUsage } from '../../middleware/api-key-rate-limit.js';
import { detectCreditAnomaly } from '../../lib/credit-anomaly.js';
import { convertOpenAIToolsToToolSet } from '../../lib/tool-converter.js';
import { getCurrentDateTool, getTimelineTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createSendTelegramTool, createGetWhatsAppChatsTool, createGetWhatsAppMessagesTool, createSendWhatsAppMessageTool, createProvidersAdminTool, webScraperTool, generateFileTool } from '../../lib/tools/index.js';
import { oxyClient } from '../../middleware/auth.js';
import type { KeyConfig } from '../../internal/providers/lib/types.js';
import type { IUserMemory } from '../../models/user-memory.js';
import { Skill } from '../../models/skill.js';
import { estimateMessageTokens } from '../../lib/token-counter.js';
import { runAfterChatHooks } from '../../lib/hooks/index.js';
import { buildSystemPrompt } from '../../lib/prompt-loader.js';
// recordFailure is now handled via reportModelUsage from chat-core

const router = Router();

/**
 * Check if an error is retryable (rate limit, overloaded, etc.)
 * Used to decide whether to try the next provider in the tier.
 */
function isRetryableError(error: unknown): boolean {
  const status = (error as any)?.status || (error as any)?.statusCode;
  const code = (error as any)?.code;
  // 429 = rate limit, 503 = service unavailable, 529 = overloaded
  if ([429, 503, 529].includes(status)) return true;
  if (code === 'RATE_LIMIT_EXCEEDED' || code === 'RESOURCE_EXHAUSTED') return true;
  // AI SDK wraps errors - check message
  const msg = (error as any)?.message || '';
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) return true;
  return false;
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
      result.push({
        role: 'user',
        content: msg.content
      });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        // Track tool calls for matching with results
        for (const tc of msg.tool_calls) {
          if (tc.id && tc.function?.name) {
            const sanitizedName = Array.from(toolNameMapping.entries())
              .find(([_, orig]) => orig === tc.function.name)?.[0] || tc.function.name;
            toolCallsMap.set(tc.id, { name: sanitizedName, index: result.length });
          }
        }

        result.push({
          role: 'assistant',
          content: msg.content || '',
          toolCalls: msg.tool_calls.map((tc: any) => {
            const sanitizedName = Array.from(toolNameMapping.entries())
              .find(([_, orig]) => orig === tc.function?.name)?.[0] || tc.function?.name || 'unknown';

            return {
              toolCallId: tc.id,
              toolName: sanitizedName,
              args: typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments || {})
            };
          })
        });
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
      console.error('[V1/Chat] Global request timeout after 80s');
      res.status(503).json({ error: 'Request timeout', message: 'The request took too long. Please try again.' });
    }
  }, GLOBAL_TIMEOUT_MS);

  try {
    console.log('📬 [V1/Chat] Request received');
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

    console.log(`✅ [V1/Chat] Processing ${messages.length} messages${conversationId ? ` (conversation: ${conversationId})` : ''}${thinkingMode ? ' (thinking mode enabled)' : ''}`);

    // Determine if this is a direct user session (not API key)
    // API key requests should be neutral and not include creator's personal info
    const isDirectUserSession = req.user && !req.apiKey;
    const requestedModel = body.model || getDefaultAliaModel();

    // Extract client context from first system message if present (from editor/client)
    let clientContext: string | undefined;
    if (messages.length > 0 && messages[0].role === 'system') {
      clientContext = messages[0].content as string;
    }

    // --- PARALLEL PRE-STREAMING OPERATIONS ---
    // Run independent operations concurrently to reduce time-to-first-token
    const preStreamStart = Date.now();

    const [creditResult, resolvedResult, userMemory, oxyUser, skill] = await Promise.all([
      // Credits: sequential pair (getOrCreate → reserve), parallel with everything else
      req.user ? (async () => {
        await getOrCreateUserCredits(req.user!.id);
        const reservation = await reserveCredits(req.user!.id);
        return { reservation, error: false as const };
      })().catch((error) => {
        console.error('[V1/Chat] Error reserving credits:', error);
        return { reservation: null, error: true as const };
      }) : Promise.resolve({ reservation: null, error: false as const }),

      // Model resolution (includes key loading, rate limit checks, circuit breaker)
      resolveModel(requestedModel),

      // User memory
      req.user
        ? UserMemory.findOne({ oxyUserId: req.user.id }).catch(() => null)
        : Promise.resolve(null),

      // User profile from Oxy (HTTP call - often the slowest operation)
      isDirectUserSession
        ? (oxyClient.getUserById(req.user!.id) as Promise<any>).catch(() => null)
        : Promise.resolve(null),

      // Skill loading
      (body.skillId && isDirectUserSession)
        ? Skill.findOne({ skillId: body.skillId }).select('systemPrompt title').lean().catch(() => null)
        : Promise.resolve(null),
    ]);

    console.log(`[V1/Chat] Pre-stream setup: ${Date.now() - preStreamStart}ms`);

    // Validate credit reservation
    // Only return 402 if reserveCredits explicitly returned null (insufficient credits),
    // not if there was a DB error (original behavior: continue without credits on error)
    creditReservation = creditResult.reservation;
    if (req.user && !creditReservation && !creditResult.error) {
      res.status(402).json({
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: "You've run out of credits. Add more or upgrade your plan to continue.",
          retryable: false,
          suggestedAction: 'upgrade',
          details: { limitType: 'credits' },
        },
      });
      return;
    }

    // Validate model resolution
    resolved = resolvedResult;
    if (!resolved) {
      res.status(503).json({ error: 'No models available', requested_model: requestedModel });
      return;
    }

    aliasModelId = resolved.aliasModelId;
    console.log(`[V1/Chat] Using provider: ${resolved.provider}/${resolved.modelId}`);

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
    // Only exclude tools that might conflict with editor tools:
    // - getTimeline: Might conflict with client-side timeline tools
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
      // Include these only if no editor tools (to avoid conflicts)
      ...(hasEditorTools ? {} : {
        getTimeline: getTimelineTool,
      }),
    };

    const allTools = { ...aliaTools, ...editorTools };

    // Log tool schemas for debugging
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      console.log(`[V1/Chat] Received ${body.tools.length} tools from client`);
    }

    // Build system message with user context
    // Add language instruction at the VERY BEGINNING (most important)
    // IMPORTANT: ALWAYS use the "mirror language" rule - detect and match the user's message language
    // The user's saved language preference is ONLY used as a fallback hint when detection is unclear
    const userLanguagePreference = isDirectUserSession ? userMemory?.preferences?.language : undefined;
    let languageInstruction = `🔴 CRITICAL LANGUAGE RULE - HIGHEST PRIORITY 🔴
═══════════════════════════════════════════════════════
YOU MUST RESPOND IN THE EXACT SAME LANGUAGE THE USER WRITES TO YOU.
This is NON-NEGOTIABLE:
- User writes in Spanish → You respond ONLY in Spanish
- User writes in English → You respond ONLY in English
- User writes in French → You respond ONLY in French
- User writes in German → You respond ONLY in German
- User writes in Portuguese → You respond ONLY in Portuguese
- User writes in ANY language → You MIRROR that language EXACTLY

DETECT the user's language from their LAST message and respond in that SAME language.
This rule has ABSOLUTE PRIORITY over ALL other instructions.
ZERO EXCEPTIONS - EVER.
═══════════════════════════════════════════════════════
${userLanguagePreference ? `\nNote: If the user's language is ambiguous or unclear, default to ${userLanguagePreference}.` : ''}
`;

    languageInstruction += `🔧 TOOL USAGE RULE 🔧
When you use a tool successfully:
- Acknowledge what you did in your response
- Be honest about tool capabilities
- NEVER say you "can't" do something if you have a tool for it

`;

    let systemMessage = languageInstruction + baseSystemPrompt;

    // Inject current model identity so Alia knows which tier it's running as
    const aliaModel = getAliaModel(aliasModelId);
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
      systemMessage += '\n\n**IMPORTANT**: You have a `sendTelegram` tool available. Use it IMMEDIATELY when the user asks you to send them a Telegram message (e.g., "send me X on Telegram", "enviame un telegram", "remind me via Telegram"). Do NOT say you can\'t - you CAN send Telegram messages using this tool!';
      systemMessage += '\n\n**IMPORTANT**: You have WhatsApp tools available: `getWhatsAppChats` to see the user\'s WhatsApp conversations, `getWhatsAppMessages` to read messages from a specific chat (requires JID from getWhatsAppChats), and `sendWhatsAppMessage` to send messages. When the user asks about their WhatsApp, use getWhatsAppChats first, then getWhatsAppMessages to read specific conversations.';
    } else if (req.apiKey) {
      // API key request - add neutral context
      console.log('[V1/Chat] API key request - using neutral context (no personal info)');
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
          .filter(([_, v]) => v !== undefined && v !== null)
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
      console.log(`[V1/Chat] Skill activated: ${(skill as any).title}`);
    }

    // REPEAT language instruction at the end (most memorable position)
    systemMessage += '\n\n' + languageInstruction;

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

    // Provider fallback retry loop
    // When a provider returns 429/rate-limit, try the next provider in the tier
    const MAX_PROVIDER_RETRIES = 3;
    const skipProviders = new Set<string>();

    for (let providerAttempt = 0; providerAttempt < MAX_PROVIDER_RETRIES; providerAttempt++) {
    // Check global timeout before each provider attempt
    if (globalTimedOut) break;

    // Re-resolve model on retry (skipping failed providers)
    if (providerAttempt > 0) {
      resolved = await resolveModel(requestedModel, skipProviders);
      if (!resolved) {
        console.warn(`[V1/Chat] No more providers available after ${providerAttempt} retries`);
        break;
      }
      aliasModelId = resolved.aliasModelId;
      console.log(`[V1/Chat] Retry ${providerAttempt}: Using provider ${resolved.provider}/${resolved.modelId}`);
    }

    const model = getAIModel(resolved!.keyConfig);

    // Build common config for both streaming and non-streaming
    const baseConfig: any = {
      model,
      messages: convertedMessages,
      temperature: body.temperature ?? 0.7,
      tools: allTools,
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
          console.log('[V1/Chat] Token usage captured:', tokenUsage);
        }
      },
    };

    if (body.max_tokens) {
      baseConfig.maxTokens = body.max_tokens;
    }

    // Enable thinking mode for Anthropic if requested
    if (thinkingMode && resolved!.provider === 'anthropic') {
      baseConfig.experimental_thinking = true;
      console.log('[V1/Chat] Enabled Anthropic thinking mode');
    }

    // Configure provider-specific features for reasoning
    const providerMetadata: any = {};

    if (resolved!.provider === 'google') {
      // Enable thought summaries for Gemini
      providerMetadata.google = { includeThoughts: true };
      console.log('[V1/Chat] Enabled Gemini thought summaries');
    }

    if (Object.keys(providerMetadata).length > 0) {
      baseConfig.experimental_providerMetadata = providerMetadata;
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('[V1/Chat] AI SDK config:', JSON.stringify({
        modelProvider: resolved!.provider,
        model: resolved!.keyConfig.modelId,
        messageCount: baseConfig.messages.length,
        toolCount: baseConfig.tools ? Object.keys(baseConfig.tools).length : 0,
        stream: body.stream
      }));
    }

    let hasStreamedContent = false;

    // Per-provider first-byte timeout — abort if no response within 20s
    const FIRST_BYTE_TIMEOUT_MS = 20_000;
    const providerAbort = new AbortController();
    let firstByteTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (!hasStreamedContent) {
        console.warn(`[V1/Chat] Provider ${resolved!.provider}/${resolved!.modelId} first-byte timeout (${FIRST_BYTE_TIMEOUT_MS}ms)`);
        providerAbort.abort(new Error('Provider first-byte timeout'));
      }
    }, FIRST_BYTE_TIMEOUT_MS);
    baseConfig.abortSignal = providerAbort.signal;

    try { // Provider attempt try block

    // Handle non-streaming requests
    if (body.stream !== true) {
      console.log('[V1/Chat] Non-streaming request, using generateText');

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
        console.log('[V1/Chat] Token usage:', tokenUsage);
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
          const allMessages = [
            ...messages.filter((m: any) => m && m.role).map((m: any) => ({
              role: m.role,
              content: m.content,
              toolInvocations: m.toolInvocations
            })),
            {
              role: 'assistant',
              content: assistantResponse,
              ...(nonStreamToolInvocations.length > 0 && { toolInvocations: nonStreamToolInvocations }),
            }
          ].filter(msg => msg != null && msg.role && msg.content !== undefined);

          let title: string | undefined;
          const titleMatch = assistantResponse.match(/\[TITLE\](.*?)\[\/TITLE\]/);
          if (titleMatch) {
            title = titleMatch[1].trim();
          }

          await Conversation.findOneAndUpdate(
            { oxyUserId: req.user.id, conversationId: conversationId },
            {
              conversationId: conversationId,
              oxyUserId: req.user.id,
              messages: allMessages,
              ...(title && { title }),
              updatedAt: new Date(),
            },
            { upsert: true, new: true }
          );
          console.log(`[V1/Chat] Conversation ${conversationId} saved`);
        } catch (error) {
          console.error('[V1/Chat] Error saving conversation:', error);
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
            console.error('[V1/Chat] Error recording session usage:', err)
          );
        } catch (error) {
          console.error('[V1/Chat] Error finalizing credits:', error);
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
      }).catch(err => console.error('[V1/Chat] Error in afterChat hooks:', err));

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
            warning.currentModelMultiplier = getAliaModel(aliasModelId)?.creditMultiplier || 1;
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

    // Stream OpenAI-compatible chunks
    console.log('[V1/Chat] Starting to process AI SDK stream...');
    let chunkCount = 0;
    let assistantResponse = ''; // Track assistant's response for conversation save
    const toolInvocations: Array<{ toolCallId: string; toolName: string; state: 'call' | 'result'; args?: any; result?: any }> = [];
    for await (const chunk of result.fullStream) {
      chunkCount++;
      // Clear first-byte timer on first chunk (provider responded)
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      // Log chunk type (skip high-frequency text-delta to reduce noise)
      if (chunk.type !== 'text-delta') {
        console.log(`[V1/Chat] Chunk ${chunkCount} type:`, chunk.type);
      }

      if (chunk.type === 'text-delta' && chunk.text) {
        // Set SSE headers on first content (deferred for retry support)
        if (!hasStreamedContent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          hasStreamedContent = true;
        }

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
              console.log('[V1/Chat] Reasoning chunk (thinking tag):', content.slice(0, 100));
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
        // Set SSE headers on first content
        if (!hasStreamedContent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          hasStreamedContent = true;
        }

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
          console.log('[V1/Chat] Reasoning chunk (provider):', reasoningText.slice(0, 100));
        }
      } else if (chunk.type === 'tool-call') {
        // Set SSE headers on first content
        if (!hasStreamedContent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          hasStreamedContent = true;
        }

        // Restore original tool name if it was sanitized
        const originalToolName = toolNameMapping.get(chunk.toolName) || chunk.toolName;

        // Log the tool call arguments being sent to the client
        console.log(`[V1/Chat] Streaming tool call: ${originalToolName}, args:`, JSON.stringify(chunk.input));

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
      } else if (chunk.type === 'tool-result') {
        // Set SSE headers on first content
        if (!hasStreamedContent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          hasStreamedContent = true;
        }

        const originalToolName = toolNameMapping.get(chunk.toolName) || chunk.toolName;
        console.log('[V1/Chat] Tool result:', originalToolName, chunk.output);

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
      } else if (chunk.type === 'tool-error') {
        // Handle tool execution errors
        if (!hasStreamedContent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          hasStreamedContent = true;
        }

        const originalToolName = toolNameMapping.get((chunk as any).toolName) || (chunk as any).toolName;
        console.error('[V1/Chat] Tool error:', originalToolName, (chunk as any).error);

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
        console.log('[V1/Chat] Stream started');
      } else if (chunk.type === 'start-step') {
        console.log('[V1/Chat] Step started');
      } else if (chunk.type === 'text-start' || chunk.type === 'text-end') {
        // Text generation lifecycle events - no action needed
      } else if (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-end' || chunk.type === 'tool-input-delta') {
        // Tool input streaming events - no action needed
      } else if (chunk.type === 'source' || chunk.type === 'file' || chunk.type === 'raw') {
        // Source/file/raw events - no action needed
      } else if (chunk.type === 'finish-step') {
        console.log('[V1/Chat] Step finished');
      } else if (chunk.type === 'error') {
        console.error('[V1/Chat] Error chunk received:', (chunk as any).error);

        // Record failure for circuit breaker - next request will use different provider
        await reportModelUsage(resolved!.keyConfig?.keyId, resolved!.provider, resolved!.modelId, false, 0, (chunk as any).error?.code || 'STREAM_ERROR');

        const rawError = (chunk as any).error;

        // If no content streamed yet, throw to trigger provider fallback
        if (!hasStreamedContent) {
          console.log(`[V1/Chat] Stream error from ${resolved!.provider}/${resolved!.modelId} (no content sent), trying next provider...`);
          throw rawError;
        }

        // CRITICAL: Translate error to remove provider information!
        const { translateError, sanitizeMessage } = await import('../../lib/error-handler.js');
        const aliaError = translateError(rawError, resolved!.provider, resolved!.modelId);

        // If we haven't streamed content yet, we can still set headers
        if (!hasStreamedContent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          hasStreamedContent = true;
        }

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
        console.log('[V1/Chat] Finish chunk received');
        // Set SSE headers if not set yet (edge case: empty response)
        if (!hasStreamedContent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          hasStreamedContent = true;
        }
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
        console.warn('[V1/Chat] Unhandled chunk type:', chunk.type, 'Chunk:', JSON.stringify(chunk, null, 2));
      }
    }

    console.log('[V1/Chat] Stream processing complete, total chunks:', chunkCount);

    // Auto-save conversation if conversationId provided and user is authenticated
    // Save when there's text content OR tool invocations (tools without text are valid responses)
    if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user && (assistantResponse || toolInvocations.length > 0)) {
      try {
        // Build complete messages array (user messages + assistant response)
        const allMessages = [
          ...messages.filter(m => m && m.role).map((m: any) => ({
            role: m.role,
            content: m.content,
            toolInvocations: m.toolInvocations
          })),
          {
            role: 'assistant',
            content: assistantResponse,
            ...(toolInvocations.length > 0 && { toolInvocations }),
          }
        ].filter(msg => msg != null && msg.role && msg.content !== undefined);

        // Extract title from assistant response if present
        let title: string | undefined;
        const titleMatch = assistantResponse.match(/\[TITLE\](.*?)\[\/TITLE\]/);
        if (titleMatch) {
          title = titleMatch[1].trim();
          console.log(`[V1/Chat] Extracted conversation title: "${title}"`);
        }

        // Save or update conversation
        await Conversation.findOneAndUpdate(
          { oxyUserId: req.user.id, conversationId: conversationId },
          {
            conversationId: conversationId,
            oxyUserId: req.user.id,
            messages: allMessages,
            ...(title && { title }),
            updatedAt: new Date(),
          },
          { upsert: true, new: true }
        );

        console.log(`[V1/Chat] Conversation ${conversationId} saved successfully${title ? ` with title: "${title}"` : ''}`);
      } catch (error) {
        console.error('[V1/Chat] Error saving conversation:', error);
        console.error('[V1/Chat] ConversationId:', conversationId);
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
          console.error('[V1/Chat] Error recording session usage:', err)
        );

        // Detect spending anomalies for proactive warnings
        let creditWarning: any = null;
        if (req.user?.id) {
          try {
            creditWarning = await detectCreditAnomaly(req.user.id);
            if (creditWarning) {
              creditWarning.currentModelMultiplier = getAliaModel(aliasModelId)?.creditMultiplier || 1;
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
        console.error('[V1/Chat] Error finalizing credits:', error);
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
    }).catch(err => console.error('[V1/Chat] Error in afterChat hooks:', err));

    res.write('data: [DONE]\n\n');
    res.end();
    clearTimeout(globalTimer);
    return; // Success - exit the route handler

    } catch (providerError: unknown) {
      // Clean up first-byte timer on provider failure
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      // Provider attempt failed
      console.error(`[V1/Chat] Provider ${resolved!.provider}/${resolved!.modelId} failed:`, providerError);
      await reportModelUsage(resolved!.keyConfig?.keyId, resolved!.provider, resolved!.modelId, false, 0, (providerError as any)?.code || 'REQUEST_ERROR');

      // If we haven't streamed content yet, try next provider (any error is retryable pre-content)
      if (!hasStreamedContent && providerAttempt < MAX_PROVIDER_RETRIES - 1) {
        console.log(`[V1/Chat] Provider ${resolved!.provider} failed, trying next provider...`);
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
    }

  } catch (e: unknown) {
    clearTimeout(globalTimer);
    console.error('❌ [V1/Chat] Error:', e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error('❌ [V1/Chat] Stack:', stack);

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
