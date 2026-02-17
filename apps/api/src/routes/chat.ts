// Internal Alia Chat API - Simple streaming endpoint
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { Router } from 'express';
import { streamText, stepCountIs, type ToolSet } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../lib/chat-core.js';
import { getAliaModel, getModelMappingsForTier } from '../lib/providers-client.js';
import { getCurrentDateTool, createGoogleSearchTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createGetDeviceInfoTool, createSendTelegramTool, createProvidersAdminTool, webScraperTool, generateFileTool, canvasTool, type DeviceInfo } from '../lib/tools/index.js';
import { optionalAuth, oxyClient } from '../middleware/auth.js';
import type { User as OxyUser } from '@oxyhq/core';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { saveConversation, extractConversationTitle } from '../lib/conversation-saver.js';
import { CanvasSession } from '../models/canvas-session.js';
import { Skill } from '../models/skill.js';
import type { IUserMemory } from '../models/user-memory.js';
import { processMessagesForPlatform } from '../lib/message-processor.js';
import { reserveCredits, finalizeCredits, safeRefund, type CreditReservation, type CreditUsage } from '../lib/credits-manager.js';
import { getOrCreateUserMemory } from '../lib/memory/user-memory-service.js';
import { estimateMessageTokens } from '../lib/token-counter.js';
import { recordUsage, getUserTier } from '../middleware/api-key-rate-limit.js';
import { runBeforeChatHooks, runAfterChatHooks } from '../lib/hooks/index.js';
import { emitCanvasUpdate } from '../socket.js';
import type { RecalledMemory } from '../lib/memory/recall.js';
import { incrementDailyCost, isApproachingDailyCap, getDailyCostCap } from '../lib/sliding-window-limiter.js';
import { checkContextFit } from '../lib/context-window-guard.js';
import { compactHistory } from '../lib/history-compaction.js';
import { log } from '../lib/logger.js';
import { writeSSE, TextBatcher, setupSSEHeaders } from '../lib/streaming-helpers.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { wrapToolsWithTruncation, getToolResultBudget } from '../lib/tools/result-truncation.js';
import { recordEvent } from '../lib/observability/index.js';

const router = Router();

// getAIModel is now imported from chat-core.ts

// Build personalized system prompt from external prompt files + user context.
// Uses recalled memories (semantic search) instead of dumping all memories.
async function buildChatSystemPrompt(
  oxyUser?: OxyUser | null,
  memory?: IUserMemory | null,
  platform: 'app' | 'telegram' = 'app',
  skillPrompt?: string | null,
  recalledMemories?: RecalledMemory[]
): Promise<string> {
  let prompt = await loadPrompt(platform === 'telegram' ? 'alia-telegram' : 'alia-app');

  // Inject skill system prompt before the base prompt
  if (skillPrompt) {
    prompt = `${skillPrompt}\n\n---\n\n${prompt}`;
  }

  const userContext: string[] = [];

  // Add user info from Oxy
  if (oxyUser) {
    if (oxyUser.name?.full || oxyUser.name?.first) {
      const fullName = oxyUser.name.full || [oxyUser.name.first, oxyUser.name.middle, oxyUser.name.last].filter(Boolean).join(' ');
      if (fullName && fullName !== 'User') {
        userContext.push(`The user's name is ${fullName}.`);
      }
    }
    if (oxyUser.username) {
      userContext.push(`The user's username is @${oxyUser.username}.`);
    }
    if (oxyUser.location) {
      userContext.push(`The user is located in ${oxyUser.location}.`);
    }
    if (oxyUser.bio) {
      userContext.push(`About the user: ${oxyUser.bio}`);
    }
    if (oxyUser.website) {
      userContext.push(`The user's website: ${oxyUser.website}`);
    }
  }

  // Add memory preferences and context (these are small and always relevant)
  if (memory) {
    if (memory.preferences?.language) {
      userContext.push(`User's preferred language: ${memory.preferences.language}. Use this if the message language is unclear.`);
    }
    if (memory.context?.occupation) {
      userContext.push(`The user works as a ${memory.context.occupation}.`);
    }
    if (memory.context?.location && !oxyUser?.location) {
      userContext.push(`The user is located in ${memory.context.location}.`);
    }
    if (memory.context?.bio && !oxyUser?.bio) {
      userContext.push(`About the user: ${memory.context.bio}`);
    }
    if (memory.preferences?.tone) {
      userContext.push(`The user prefers a ${memory.preferences.tone} tone in responses.`);
    }
    if (memory.preferences?.responseLength) {
      userContext.push(`The user prefers ${memory.preferences.responseLength} responses.`);
    }
    if (memory.preferences?.interests?.length) {
      userContext.push(`The user is interested in: ${memory.preferences.interests.join(', ')}.`);
    }
  }

  // Inject only recalled (relevant) memories instead of ALL memories
  if (recalledMemories && recalledMemories.length > 0) {
    const memoryItems = recalledMemories.map(m => `- ${m.key}: ${m.value}`).join('\n');
    userContext.push(`\nRelevant things to remember about the user:\n${memoryItems}`);
  } else if (memory?.memories?.length) {
    // Fallback: if recall didn't run (e.g. unauthenticated), use all memories
    const memoryItems = memory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
    userContext.push(`\nThings to remember about the user:\n${memoryItems}`);
  }

  if (userContext.length > 0) {
    log.chat.info({ userContext }, 'Personalization applied');
    prompt = `# USER CONTEXT\n\n${userContext.join('\n')}\n\n---\n\n${prompt}`;
  }

  return prompt;
}


router.post('/', optionalAuth, async (req, res) => {
  // Set a timeout for the entire request (90 seconds)
  const requestTimeout = setTimeout(() => {
    if (!res.headersSent) {
      log.chat.error('Request timeout after 90s');
      res.status(504).json({ error: 'Request timeout - server took too long to respond' });
    }
  }, 90000);

  // Declare creditReservation outside try block so it's accessible in catch
  let creditReservation: CreditReservation | null = null;
  const requestStartTime = Date.now();

  try {
    const { messages, conversationId, model: requestedModel, thinkingMode, skillId } = req.body as {
      messages: any[];
      conversationId?: string;
      model?: string;
      thinkingMode?: boolean;
      skillId?: string;
    };

    if (!messages || !messages.length) {
      clearTimeout(requestTimeout);
      res.status(400).json({ error: 'No messages provided' });
      return;
    }

    if (thinkingMode) {
      log.chat.info('Thinking mode enabled for this request');
    }

    log.chat.info('Request received, loading keys...');
    if (requestedModel) {
      log.chat.info({ requestedModel }, 'User requested model');
    }

    // Extract device info from headers if available
    let deviceInfo: DeviceInfo | null = null;
    const deviceInfoHeader = req.headers['x-device-info'];
    if (deviceInfoHeader && typeof deviceInfoHeader === 'string') {
      try {
        deviceInfo = JSON.parse(deviceInfoHeader);
      } catch (e) {
        log.chat.error({ err: e }, 'Failed to parse device info header');
      }
    }

    // Determine source platform from headers
    // x-source header can be: app, telegram, api, web, discord, whatsapp, slack
    // Platform type supports 'app' | 'telegram' for message processing
    const sourceHeader = req.headers['x-source'] as string | undefined;
    const isTelegram = req.headers['x-telegram-bot'] === 'true';
    const platform: 'app' | 'telegram' = (sourceHeader === 'telegram' || isTelegram ? 'telegram' : 'app');

    // Process incoming messages to remove platform-incompatible tags
    // This saves tokens by not sending irrelevant formatting to the AI
    const processedMessages = processMessagesForPlatform(
      messages.filter(m => m && m.role).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      platform
    );

    // Get user data from session and credits/memory from local DB
    let userCredits: any = null;
    let memory: IUserMemory | null = null;
    let userTier: string | undefined;

    if (req.user) {
      try {
        log.chat.info('Loading user data...');

        // Get or create local credits record
        userCredits = await getOrCreateUserCredits(req.user.id);

        memory = await getOrCreateUserMemory(req.user.id);

        // Get user tier for spending alerts
        userTier = await getUserTier(req.user.id);

        // Refresh credits if needed
        await userCredits.refreshCreditsIfNeeded();

        // Reserve credits using centralized manager
        creditReservation = await reserveCredits(req.user.id);

        if (!creditReservation) {
          log.chat.info('Insufficient credits');
          clearTimeout(requestTimeout);
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

        log.chat.info('User data loaded successfully');
      } catch (error) {
        log.chat.error({ err: error }, 'Error fetching user data');
      }
    }

    let resolved;

    try {
      const aliasModelId = requestedModel || getDefaultAliaModel();
      log.chat.info({ aliasModelId }, 'Resolving model');
      resolved = await resolveModel(aliasModelId);
      log.chat.info({ resolved: resolved ? `${resolved.aliasModelId} -> ${resolved.provider}/${resolved.modelId}` : 'none' }, 'Resolved model');
    } catch (keyError: any) {
      log.chat.error({ err: keyError }, 'Error loading keys');
      clearTimeout(requestTimeout);

      await safeRefund(creditReservation, 'key resolution error');

      res.status(503).json({
        error: 'Service temporarily unavailable',
        details: 'Unable to connect to AI models. Please try again later.'
      });
      return;
    }

    if (!resolved) {
      log.chat.info('No available models');
      clearTimeout(requestTimeout);

      await safeRefund(creditReservation, 'no available models');

      res.status(503).json({
        error: 'No AI models available',
        details: 'All models are currently unavailable or disabled. Please try again later.'
      });
      return;
    }

    const model = getAIModel(resolved.keyConfig);

    // Record agent start event for observability
    recordEvent({
      type: 'agent.start',
      timestamp: Date.now(),
      provider: resolved.provider,
      modelId: resolved.aliasModelId,
      userId: req.user?.id,
      conversationId,
      platform,
    });

    const googleApiKey = resolved.keyConfig.provider === 'google' ? resolved.keyConfig.key : null;
    const tools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      webScraper: webScraperTool,
      generateFile: generateFileTool,
      canvas: canvasTool,
      ...(googleApiKey ? { googleSearch: createGoogleSearchTool(googleApiKey) } : {}),
      // Add device info tool if device info is available
      ...(deviceInfo ? { getDeviceInfo: createGetDeviceInfoTool(deviceInfo) } : {}),
      // Add memory tools for authenticated users
      ...(req.user ? {
        saveUserMemory: saveUserMemoryTool(req.user.id),
        updateUserPreferences: updateUserPreferencesTool(req.user.id),
        updateUserContext: updateUserContextTool(req.user.id),
        sendTelegramMessage: createSendTelegramTool(req.user.id)
      } : {})
    };

    // Fetch full user profile from Oxy for personalization
    let oxyUser: OxyUser | null = null;
    if (req.user?.id) {
      try {
        oxyUser = await oxyClient.getUserById(req.user.id) as OxyUser;
      } catch (e) {
        log.chat.error({ err: e }, 'Could not fetch Oxy user profile');
      }
    }

    // Add admin tools for authorized users
    if (oxyUser?.username === 'nate') {
      tools.providersAdmin = createProvidersAdminTool();
    }

    // Look up active skill system prompt if skillId provided
    let skillPrompt: string | null = null;
    if (skillId) {
      try {
        const skill = await Skill.findOne({ skillId }).select('systemPrompt title').lean();
        if (skill?.systemPrompt) {
          skillPrompt = `# ACTIVE SKILL: ${skill.title}\n\n${skill.systemPrompt}`;
          log.chat.info({ skillTitle: skill.title }, 'Skill activated');
        }
      } catch (e) {
        log.chat.error({ err: e }, 'Error loading skill');
      }
    }

    // Run beforeChat hooks (memory recall, etc.)
    let recalledMemories: RecalledMemory[] | undefined;
    if (req.user?.id) {
      try {
        const hookResult = await runBeforeChatHooks({
          userId: req.user.id,
          conversationId,
          messages: processedMessages,
          model: resolved.aliasModelId,
          skillId,
          platform,
          metadata: {},
        });
        recalledMemories = hookResult.metadata?.recalledMemories as RecalledMemory[] | undefined;
        if (recalledMemories?.length) {
          log.chat.info({ recalled: recalledMemories.length, total: memory?.memories?.length || 0 }, 'Memory recall');
        }
      } catch (e) {
        log.chat.error({ err: e }, 'beforeChat hooks error');
      }
    }

    // Build personalized system prompt (with skill injection + recalled memories)
    let systemPrompt = await buildChatSystemPrompt(oxyUser, memory, platform, skillPrompt, recalledMemories);

    // Inject current model identity so Alia knows which tier it's running as
    const aliaModel = await getAliaModel(resolved.aliasModelId);
    if (aliaModel) {
      systemPrompt += `\n\nYou are currently using the **${aliaModel.name}** model. When asked what model you use, say you are using ${aliaModel.name}.`;
    }

    // Estimate system prompt tokens (so we don't charge users for our system prompts)
    const systemPromptTokens = estimateMessageTokens('system', systemPrompt);
    log.chat.info({ systemPromptTokens }, 'Estimated system prompt tokens');

    // Get model context window from tier mappings
    const tierMappings = aliaModel ? await getModelMappingsForTier(aliaModel.tier) : [];
    const modelContextTokens = tierMappings[0]?.capabilities?.maxContextTokens || 128000;

    // Context window guard — block if messages would exceed 90% of context
    const contextCheck = checkContextFit(processedMessages as any, systemPrompt, modelContextTokens);
    if (!contextCheck.fits) {
      clearTimeout(requestTimeout);
      await safeRefund(creditReservation, 'context length exceeded');
      res.status(400).json({
        error: 'Your conversation is too long for this model. Please start a new chat or use a shorter message.',
        code: 'CONTEXT_LENGTH_EXCEEDED',
        details: { estimatedTokens: contextCheck.estimatedTokens, limit: contextCheck.contextLimit, usage: contextCheck.usage },
      });
      return;
    }

    // History compaction — trim older messages if approaching context limit
    const historyBudget = Math.floor(modelContextTokens * 0.6); // 60% of context for history
    const compactedMessages = compactHistory(processedMessages as any, historyBudget);

    // Wrap tools with truncation to cap large tool results (saves tokens)
    const toolResultBudget = getToolResultBudget(modelContextTokens);
    const truncatedTools = wrapToolsWithTruncation(tools, toolResultBudget);

    // Set headers for SSE streaming
    setupSSEHeaders(res);

    // Track usage for credits
    let tokenUsage: CreditUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      systemPromptTokens,
    };

    // Configure streamText with thinking mode support
    const streamConfig: any = {
      model,
      messages: compactedMessages as any, // Compacted messages (saves tokens)
      tools: truncatedTools,
      stopWhen: stepCountIs(5),
      system: systemPrompt,
      temperature: 0.6,
      onFinish: async (result) => {
        // Capture token usage from AI SDK
        // AI SDK uses inputTokens/outputTokens, not promptTokens/completionTokens
        if (result.usage) {
          tokenUsage = {
            promptTokens: result.usage.inputTokens || 0,
            completionTokens: result.usage.outputTokens || 0,
            totalTokens: result.usage.totalTokens || 0,
            systemPromptTokens, // Keep our estimated system prompt tokens
          };
          log.chat.info({ tokenUsage }, 'Token usage captured');
        } else {
          log.chat.warn('No usage data available from AI SDK');
        }
      },
    };

    // Enable extended thinking for Anthropic models when thinking mode is requested
    if (thinkingMode && resolved.provider === 'anthropic') {
      log.chat.info('Configuring Anthropic extended thinking mode');
      streamConfig.experimental_thinking = true;
    }

    const result = streamText(streamConfig);

    // Stream all events including tool calls
    let assistantResponse = '';
    let hasReceivedContent = false;
    let streamTimeout: NodeJS.Timeout | null = null;
    const batcher = new TextBatcher(res);

    // Tool invocation tracking (ZeroClaw pattern)
    const toolTimers = new Map<string, number>(); // toolCallId → startTime
    let toolCallCount = 0;
    const MAX_TOOL_CALLS = 15;

    // Set a timeout for stream inactivity (30 seconds without any content)
    const resetStreamTimeout = () => {
      if (streamTimeout) clearTimeout(streamTimeout);
      streamTimeout = setTimeout(() => {
        if (!hasReceivedContent && !res.writableEnded) {
          log.chat.error('Stream timeout - no content received in 30s');
          batcher.flush();
          const errorEvent = {
            type: 'error',
            error: 'Stream timeout - the AI model did not respond in time. Please try again.'
          };
          writeSSE(res, `data: ${JSON.stringify(errorEvent)}\n\n`);
          writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        }
      }, 30000) as any;
    };

    resetStreamTimeout();

    try {
      for await (const chunk of result.fullStream) {
        // Mark that we've received content
        if (chunk.type === 'text-delta' || chunk.type === 'tool-call' || (chunk as any).type === 'thinking-delta') {
          hasReceivedContent = true;
          if (streamTimeout) clearTimeout(streamTimeout);
        }

        // Handle thinking deltas (extended thinking mode)
        if ((chunk as any).type === 'thinking-delta' && thinkingMode) {
          // Flush any pending text first
          batcher.flush();

          // Send thinking content to frontend
          const thinkingEvent = JSON.stringify({
            type: 'thinking-delta',
            text: (chunk as any).text || (chunk as any).thinking || ''
          });
          writeSSE(res, `data: ${thinkingEvent}\n\n`);
          continue;
        }

        // Handle text deltas with intelligent batching
        if (chunk.type === 'text-delta') {
          assistantResponse += chunk.text;
          batcher.add(chunk.text);
        }
        // Non-text events (tool calls, etc.) are sent immediately
        else {
          // Flush any pending text first
          batcher.flush();

          // Track tool call timing (start)
          if (chunk.type === 'tool-call') {
            toolTimers.set((chunk as any).toolCallId, Date.now());
            toolCallCount++;

            // Tool iteration guard (ZeroClaw limits to 10, we allow 15)
            if (toolCallCount > MAX_TOOL_CALLS) {
              log.chat.warn({ toolCallCount, max: MAX_TOOL_CALLS }, 'Tool call limit exceeded');
              writeSSE(res, `data: ${JSON.stringify({
                type: 'error',
                error: 'Too many tool calls in a single request. Please simplify your request.'
              })}\n\n`);
              break;
            }
          }

          // Track tool call timing (end) + record observability event
          if (chunk.type === 'tool-result') {
            const startTime = toolTimers.get((chunk as any).toolCallId);
            const durationMs = startTime ? Date.now() - startTime : 0;
            toolTimers.delete((chunk as any).toolCallId);

            recordEvent({
              type: 'tool.call',
              timestamp: Date.now(),
              toolName: (chunk as any).toolName || 'unknown',
              durationMs,
              success: !(chunk as any).isError,
              resultSizeChars: JSON.stringify((chunk as any).result || '').length,
            });
          }

          // Log extracted title (saveConversation handles full extraction + tag stripping)
          if (chunk.type === 'finish' && assistantResponse) {
            log.chat.info({ title: extractConversationTitle(assistantResponse, messages) }, 'Extracted title');
          }

          // Handle canvas tool results - persist and emit via Socket.IO
          if (chunk.type === 'tool-result' && (chunk as any).toolName === 'canvas' && (chunk as any).result) {
            const component = (chunk as any).result;
            if (conversationId && req.user?.id) {
              CanvasSession.findOneAndUpdate(
                { oxyUserId: req.user.id, conversationId },
                { $push: { components: { ...component, createdAt: new Date() } } },
                { upsert: true, new: true }
              ).catch(err => log.chat.error({ err }, 'Canvas save error'));
              emitCanvasUpdate(conversationId, component);
            }
            // Send as canvas-component event to SSE
            const canvasEvent = JSON.stringify({ type: 'canvas-component', component });
            writeSSE(res, `data: ${canvasEvent}\n\n`);
          }

          // Send non-text event
          const event = JSON.stringify(chunk);
          writeSSE(res, `data: ${event}\n\n`);
        }
      }

      // Flush any remaining text and clean up batcher
      batcher.cleanup();

      // Clear stream timeout
      if (streamTimeout) clearTimeout(streamTimeout);

      // Check if we got any response
      if (!hasReceivedContent) {
        log.chat.error('Stream completed but no content was received');
        const errorEvent = {
          type: 'error',
          error: 'No response received from AI model. Please try again.'
        };
        log.chat.info('Sending empty stream error to client');
        writeSSE(res, `data: ${JSON.stringify(errorEvent)}\n\n`);
      }

      // Record agent.end for observability (success path)
      recordEvent({
        type: 'agent.end',
        timestamp: Date.now(),
        durationMs: Date.now() - requestStartTime,
        inputTokens: tokenUsage.promptTokens,
        outputTokens: tokenUsage.completionTokens,
        toolCallCount,
      });
    } catch (streamError: any) {
      log.chat.error({ err: streamError }, 'Error during streaming');

      // Record agent.end for observability (error path)
      recordEvent({
        type: 'agent.end',
        timestamp: Date.now(),
        durationMs: Date.now() - requestStartTime,
        toolCallCount,
        error: streamError.message,
      });

      // Clean up timers and flush pending text
      if (streamTimeout) clearTimeout(streamTimeout);
      batcher.cleanup();

      if (!res.writableEnded) {
        const errorEvent = {
          type: 'error',
          error: streamError.message || 'An error occurred while streaming the response'
        };
        log.chat.info({ error: errorEvent.error }, 'Sending stream error to client');
        writeSSE(res, `data: ${JSON.stringify(errorEvent)}\n\n`);
      }

      await safeRefund(creditReservation, 'streaming error');

      throw streamError; // Re-throw to be caught by outer try-catch
    }

    // Finalize credits based on actual token usage and model tier
    if (creditReservation && req.user) {
      try {
        log.chat.info({ tokenUsage }, 'About to finalize credits with token usage');
        const { creditsCharged, creditsRemaining } = await finalizeCredits(
          creditReservation,
          tokenUsage,
          resolved?.aliasModelId
        );

        log.chat.info({ creditsCharged, creditsRemaining }, 'Credits finalized successfully');

        // Track daily cost in sliding window limiter
        incrementDailyCost(req.user.id, creditsCharged);

        const creditUpdate = {
          type: 'credit-update',
          credits: creditsRemaining,
          creditsUsed: creditsCharged,
          totalTokens: tokenUsage.totalTokens,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
        };
        log.chat.info({ creditUpdate }, 'Sending credit update event');
        writeSSE(res, `data: ${JSON.stringify(creditUpdate)}\n\n`);

        // Send spending alert if approaching daily cost cap
        if (isApproachingDailyCap(req.user.id, userTier || 'free')) {
          const cap = getDailyCostCap(userTier || 'free');
          writeSSE(res, `data: ${JSON.stringify({
            type: 'spending-alert',
            message: 'You are approaching your daily usage limit.',
            dailyCostCap: cap,
          })}\n\n`);
        }

        // Record usage so the credits usage chart has data
        recordUsage(req, 200, tokenUsage.totalTokens, undefined, creditsCharged).catch(err =>
          log.chat.error({ err }, 'Error recording usage')
        );
      } catch (error) {
        log.chat.error({ err: error }, 'Error finalizing credits');
      }
    } else {
      log.chat.info({ hasCreditReservation: !!creditReservation, hasUser: !!req.user }, 'Skipping credit finalization');
    }

    // Fire afterChat hooks (non-blocking)
    runAfterChatHooks({
      userId: req.user?.id,
      conversationId,
      messages,
      model: resolved?.aliasModelId || 'alia-v1',
      skillId,
      platform: 'app',
      metadata: { provider: resolved?.provider || 'unknown' },
      response: assistantResponse,
      tokenUsage,
      modelUsed: resolved?.keyConfig?.modelId || 'unknown',
      latencyMs: Date.now() - requestStartTime,
    }).catch(err => log.chat.error({ err }, 'Error in afterChat hooks'));

    // Auto-save conversation if conversationId provided and user is authenticated
    if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user && assistantResponse) {
      try {
        await saveConversation({
          userId: req.user.id,
          conversationId,
          messages,
          assistantResponse,
          source: platform,
        });
        log.chat.info({ conversationId }, 'Conversation saved successfully');
      } catch (error) {
        log.chat.error({ err: error, conversationId }, 'Error saving conversation');
      }
    } else if (!conversationId && req.user) {
      log.chat.warn('ConversationId not provided - conversation will not be saved');
    }

    // Send completion marker
    writeSSE(res, 'data: [DONE]\n\n');
    res.end();
    clearTimeout(requestTimeout);

  } catch (e: any) {
    log.chat.error({ err: e }, 'Request failed');
    clearTimeout(requestTimeout);

    await safeRefund(creditReservation, 'request failed');

    if (!res.headersSent) {
      // Headers not sent yet, send JSON error
      res.status(500).json({
        error: e.message || 'An error occurred while processing your request',
        details: e.stack ? e.stack.split('\n')[0] : undefined
      });
    } else {
      // Headers already sent (streaming started), send error event and close
      const errorEvent = {
        type: 'error',
        error: e.message || 'An error occurred while processing your request'
      };
      writeSSE(res, `data: ${JSON.stringify(errorEvent)}\n\n`);
      writeSSE(res, 'data: [DONE]\n\n');
      res.end();
    }
  }
});

router.get('/', async (req, res) => {
  res.json({
    status: '🟢 Online',
    service: 'Alia AI Chat',
    tools: {
      getCurrentDate: true,
      googleSearch: true,
      webScraper: true
    }
  });
});

export default router;
