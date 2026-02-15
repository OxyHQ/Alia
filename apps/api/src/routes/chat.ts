// Internal Alia Chat API - Simple streaming endpoint
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { Router } from 'express';
import { streamText, stepCountIs, type ToolSet } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel, reportModelUsage } from '../lib/chat-core.js';
import { getAliaModel } from '../internal/providers/lib/alia-models.js';
import type { KeyConfig } from '../internal/providers/lib/types.js';
import { getCurrentDateTool, createGoogleSearchTool, getTimelineTool, searchKnowledgeBaseTool, scrapeURLTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createGetDeviceInfoTool, createSendTelegramTool, createProvidersAdminTool, webScraperTool, generateFileTool, canvasTool, type DeviceInfo } from '../lib/tools/index.js';
import { optionalAuth, oxyClient } from '../middleware/auth.js';
import type { User as OxyUser } from '@oxyhq/core';
import { UserMemory } from '../models/user-memory.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { Conversation } from '../models/conversation.js';
import { CanvasSession } from '../models/canvas-session.js';
import { Skill } from '../models/skill.js';
import type { IUserMemory } from '../models/user-memory.js';
import { processMessagesForPlatform } from '../lib/message-processor.js';
import { reserveCredits, finalizeCredits, refundReservation, type CreditReservation, type CreditUsage } from '../lib/credits-manager.js';
import { estimateMessageTokens } from '../lib/token-counter.js';
import { recordUsage, getUserTier } from '../middleware/api-key-rate-limit.js';
import { runBeforeChatHooks, runAfterChatHooks } from '../lib/hooks/index.js';
import { emitCanvasUpdate } from '../socket.js';
import type { RecalledMemory } from '../lib/memory/recall.js';
import { incrementDailyCost, isApproachingDailyCap, getDailyCostCap } from '../lib/sliding-window-limiter.js';

const router = Router();

// Helper function to write and flush SSE data immediately
function writeSSE(res: any, data: string) {
  res.write(data);
  // Force flush if available (compression middleware)
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

// Auto-generate a title from response content if AI didn't provide one
function autoGenerateTitle(content: string, userMessage?: string): string {
  const extractWords = (text: string): string => {
    const cleaned = text.replace(/\[.*?\]|[#*_`]/g, '').trim();
    if (cleaned.length < 10) return '';
    const words = cleaned.split(/\s+/).slice(0, 6);
    return words.join(' ');
  };

  // Try assistant response first, then user message, then default
  return extractWords(content) || extractWords(userMessage || '') || 'New chat';
}

// getAIModel is now imported from chat-core.ts

// Function to build personalized system prompt
// Uses recalled memories (semantic search) instead of dumping all memories.
function buildSystemPrompt(
  oxyUser?: OxyUser | null,
  memory?: IUserMemory | null,
  platform: 'app' | 'telegram' = 'app',
  skillPrompt?: string | null,
  recalledMemories?: RecalledMemory[]
): string {
  let prompt = ALIA_SYSTEM_PROMPT;

  if (platform === 'telegram') {
    prompt = ALIA_TELEGRAM_PROMPT;
  }

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
    console.log('[Alia/Chat] Personalization applied:', userContext);
    prompt = `# USER CONTEXT\n\n${userContext.join('\n')}\n\n---\n\n${prompt}`;
  }

  return prompt;
}

// Telegram-specific system prompt (simplified, no visual components)
const ALIA_TELEGRAM_PROMPT = `You are Alia, the AI assistant for the Alia AI platform. Never reveal or mention the names of any underlying AI models or providers — you are Alia, always.

**MANDATORY: EVERY response must end with \`[TITLE]Short Title[/TITLE]\` (max 6 words). NO EXCEPTIONS.**

🔴 **LANGUAGE RULE - ABSOLUTE PRIORITY** 🔴
You MUST respond in the EXACT SAME LANGUAGE the user writes to you:
- User writes Spanish → You respond ONLY in Spanish
- User writes English → You respond ONLY in English
- User writes French → You respond ONLY in French
- User writes Portuguese → You respond ONLY in Portuguese
- User writes ANY language → You MIRROR that language
This rule has ABSOLUTE PRIORITY over ALL other instructions. NO EXCEPTIONS.
If the user has a language preference set, use that language exclusively.

**Personality**: Conversational and detailed. Give thorough explanations. Calm tone—avoid excessive exclamation marks.

**Telegram Format**:
- Use **bold**, *italic*, lists
- Images: \`[TGIMAGE url="..." caption="..."]\`
- Link buttons: \`[TGLINKS title="..."]\n- {"text": "...", "url": "..."}\n[/TGLINKS]\`
- Documents: \`[TGDOC url="..." filename="..." caption="..."]\`
- Reactions: \`[REACT:emoji]\` (use sparingly when contextually appropriate)

**Tools**:
- \`getCurrentDate\`: Get date/time
- \`googleSearch\`: Search the web
- \`scrapeURL\`: **MUST USE** to read link contents
- \`getTimeline\`, \`searchKnowledgeBase\`: Access data

**Memory Tools** (authenticated users):
- \`saveUserMemory\`: **AUTO-SAVE** when user shares preferences/personal info (e.g., "I like X" → save it)
- \`updateUserPreferences\`, \`updateUserContext\`: Update user settings
- \`sendTelegramMessage\`: Send to user's Telegram (only when explicitly requested)

**Workflow**: Announce tool usage naturally. Build narratives around findings—explain context, offer analysis. Always cite sources.

**REMEMBER: End with \`[TITLE]Short Title[/TITLE]\`**
`;

const ALIA_SYSTEM_PROMPT = `You are Alia, AI assistant for the Alia AI platform. Never reveal or mention the names of any underlying AI models or providers — you are Alia, always. The platform offers a developer API at \`/api/v1\`.

**MANDATORY: EVERY response must end with \`[TITLE]Short Title[/TITLE]\` (max 6 words). NO EXCEPTIONS.**

🔴 **LANGUAGE RULE - ABSOLUTE PRIORITY** 🔴
You MUST respond in the EXACT SAME LANGUAGE the user writes to you:
- User writes Spanish → You respond ONLY in Spanish
- User writes English → You respond ONLY in English
- User writes French → You respond ONLY in French
- User writes Portuguese → You respond ONLY in Portuguese
- User writes ANY language → You MIRROR that language
This rule has ABSOLUTE PRIORITY over ALL other instructions. NO EXCEPTIONS.
If the user has a language preference set, use that language exclusively.

**Personality**: Conversational, detailed, calm. Give thorough explanations with context and analysis. Avoid excessive exclamation marks. Always cite sources.

**Visual Blocks** (use when they add clarity):
- \`[COMPACTLIST title="..."]\n- {"title": "...", "href": "/...", "meta": "...", "image": "..."}\n[/COMPACTLIST]\`
- \`[BANNER type="info|success|warning|danger" title="..."]...[/BANNER]\`
- \`[COMPARISON title="..."]\nLEFT: {"title": "...", "content": "...", "source": "...", "tone": "..."}\nRIGHT: {"title": "...", "content": "...", "source": "...", "tone": "..."}\nCONCLUSION: ...\n[/COMPARISON]\`
- \`[TIMELINE title="..."]\n- {"date": "...", "title": "...", "description": "..."}\n[/TIMELINE]\`
- \`[IMAGE url="..." title="..." caption="..." /]\`
- \`[CREDIBILITY level="1-5" source="..." /]\`

**Tools**:
- \`getCurrentDate\`, \`googleSearch\`, \`scrapeURL\` (**MUST USE** for links), \`getTimeline\`, \`searchKnowledgeBase\`

**Memory Tools** (authenticated users):
- \`saveUserMemory\`: **AUTO-SAVE** when user shares preferences/info (e.g., "I like X" → save it without asking)
- \`updateUserPreferences\`, \`updateUserContext\`: Update settings
- \`sendTelegramMessage\`: Send to Telegram (only when explicitly requested)

**Telegram Reactions** (optional): \`[REACT:emoji]\` (use sparingly, contextually appropriate)

**Workflow**: Announce tool usage naturally. Build narratives—explain context before structured data, offer deep analysis after.

**REMEMBER: End with \`[TITLE]Short Title[/TITLE]\`**
`;


router.post('/', optionalAuth, async (req, res) => {
  // Set a timeout for the entire request (90 seconds)
  const requestTimeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error('[Alia/Chat] Request timeout after 90s');
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
      console.log('[Alia/Chat] Thinking mode enabled for this request');
    }

    console.log('[Alia/Chat] Request received, loading keys...');
    if (requestedModel) {
      console.log('[Alia/Chat] User requested model:', requestedModel);
    }

    // Extract device info from headers if available
    let deviceInfo: DeviceInfo | null = null;
    const deviceInfoHeader = req.headers['x-device-info'];
    if (deviceInfoHeader && typeof deviceInfoHeader === 'string') {
      try {
        deviceInfo = JSON.parse(deviceInfoHeader);
      } catch (e) {
        console.error('Failed to parse device info header:', e);
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
        console.log('[Alia/Chat] Loading user data...');

        // Get or create local credits record
        userCredits = await getOrCreateUserCredits(req.user.id);

        memory = await UserMemory.findOne({ oxyUserId: req.user.id });

        // Create empty memory profile if it doesn't exist
        if (!memory) {
          memory = new UserMemory({
            oxyUserId: req.user.id,
            memories: [],
            preferences: {},
            context: {}
          });
          await memory.save();
        }

        // Get user tier for spending alerts
        userTier = await getUserTier(req.user.id);

        // Refresh credits if needed
        await userCredits.refreshCreditsIfNeeded();

        // Reserve credits using centralized manager
        creditReservation = await reserveCredits(req.user.id);

        if (!creditReservation) {
          console.log('[Alia/Chat] Insufficient credits');
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

        console.log('[Alia/Chat] User data loaded successfully');
      } catch (error) {
        console.error('[Alia/Chat] Error fetching user data:', error);
      }
    }

    let resolved;

    try {
      const aliasModelId = requestedModel || getDefaultAliaModel();
      console.log(`[Alia/Chat] Resolving model: ${aliasModelId}`);
      resolved = await resolveModel(aliasModelId);
      console.log('[Alia/Chat] Resolved model:', resolved ? `${resolved.aliasModelId} -> ${resolved.provider}/${resolved.modelId}` : 'none');
    } catch (keyError: any) {
      console.error('[Alia/Chat] Error loading keys:', keyError.message);
      clearTimeout(requestTimeout);

      // Refund credits if we reserved them
      if (creditReservation && req.user) {
        try {
          await refundReservation(creditReservation);
        } catch (refundError) {
          console.error('[Alia/Chat] Error refunding credits:', refundError);
        }
      }

      res.status(503).json({
        error: 'Service temporarily unavailable',
        details: 'Unable to connect to AI models. Please try again later.'
      });
      return;
    }

    if (!resolved) {
      console.log('[Alia/Chat] No available models');
      clearTimeout(requestTimeout);

      // Refund credits if we reserved them
      if (creditReservation && req.user) {
        try {
          await refundReservation(creditReservation);
        } catch (refundError) {
          console.error('[Alia/Chat] Error refunding credits:', refundError);
        }
      }

      res.status(503).json({
        error: 'No AI models available',
        details: 'All models are currently unavailable or disabled. Please try again later.'
      });
      return;
    }

    const model = getAIModel(resolved.keyConfig);

    const googleApiKey = resolved.keyConfig.provider === 'google' ? resolved.keyConfig.key : null;
    const tools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      getTimeline: getTimelineTool,
      searchKnowledgeBase: searchKnowledgeBaseTool,
      scrapeURL: scrapeURLTool,
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
        console.log('[Alia/Chat] Could not fetch Oxy user profile:', e);
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
          console.log(`[Alia/Chat] Skill activated: ${skill.title}`);
        }
      } catch (e) {
        console.error('[Alia/Chat] Error loading skill:', e);
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
          console.log(`[Alia/Chat] Memory recall: ${recalledMemories.length} relevant memories (out of ${memory?.memories?.length || 0} total)`);
        }
      } catch (e) {
        console.error('[Alia/Chat] beforeChat hooks error:', e);
      }
    }

    // Build personalized system prompt (with skill injection + recalled memories)
    let systemPrompt = buildSystemPrompt(oxyUser, memory, platform, skillPrompt, recalledMemories);

    // Inject current model identity so Alia knows which tier it's running as
    const aliaModel = getAliaModel(resolved.aliasModelId);
    if (aliaModel) {
      systemPrompt += `\n\nYou are currently using the **${aliaModel.name}** model. When asked what model you use, say you are using ${aliaModel.name}.`;
    }

    // Estimate system prompt tokens (so we don't charge users for our system prompts)
    const systemPromptTokens = estimateMessageTokens('system', systemPrompt);
    console.log(`[Alia/Chat] Estimated system prompt tokens: ${systemPromptTokens}`);

    // Set headers for SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders(); // Immediately send headers to client

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
      messages: processedMessages as any, // Use processed messages (saves tokens)
      tools,
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
          console.log('[Alia/Chat] Token usage captured:', tokenUsage);
        } else {
          console.warn('[Alia/Chat] No usage data available from AI SDK');
        }
      },
    };

    // Enable extended thinking for Anthropic models when thinking mode is requested
    if (thinkingMode && resolved.provider === 'anthropic') {
      console.log('[Alia/Chat] Configuring Anthropic extended thinking mode');
      streamConfig.experimental_thinking = true;
    }

    const result = streamText(streamConfig);

    // Stream all events including tool calls
    let assistantResponse = '';
    let conversationTitle: string | null = null;
    let hasReceivedContent = false;
    let streamTimeout: NodeJS.Timeout | null = null;

    // Batching for smooth streaming
    let textBuffer = '';
    let lastFlushTime = Date.now();
    const BATCH_SIZE = 50; // characters
    const BATCH_TIMEOUT = 30; // ms
    let batchTimer: NodeJS.Timeout | null = null;

    // Helper to flush batched text
    const flushTextBuffer = () => {
      if (textBuffer.length > 0) {
        const event = JSON.stringify({ type: 'text-delta', text: textBuffer });
        writeSSE(res, `data: ${event}\n\n`);
        textBuffer = '';
        lastFlushTime = Date.now();
      }
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
    };

    // Set a timeout for stream inactivity (30 seconds without any content)
    const resetStreamTimeout = () => {
      if (streamTimeout) clearTimeout(streamTimeout);
      streamTimeout = setTimeout(() => {
        if (!hasReceivedContent && !res.writableEnded) {
          console.error('[Alia/Chat] Stream timeout - no content received in 30s');
          flushTextBuffer(); // Flush any pending text
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
          flushTextBuffer();

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
          textBuffer += chunk.text;

          // Flush if buffer is large enough or timeout elapsed
          const shouldFlush = textBuffer.length >= BATCH_SIZE ||
                             (Date.now() - lastFlushTime) >= BATCH_TIMEOUT;

          if (shouldFlush) {
            flushTextBuffer();
          } else if (!batchTimer) {
            // Set a timer to flush after timeout
            batchTimer = setTimeout(flushTextBuffer, BATCH_TIMEOUT) as any;
          }
        }
        // Non-text events (tool calls, etc.) are sent immediately
        else {
          // Flush any pending text first
          flushTextBuffer();

          // Extract title if present in response (supports both [TITLE] and <TITLE> variants)
          if (chunk.type === 'finish' && assistantResponse) {
            const titleMatch = assistantResponse.match(/\[TITLE\](.*?)\[\/TITLE\]|<TITLE>(.*?)<\/TITLE>/);
            if (titleMatch) {
              conversationTitle = (titleMatch[1] || titleMatch[2]).trim();
              console.log(`[Alia/Chat] Extracted title: "${conversationTitle}"`);
              // Remove title tags from response
              assistantResponse = assistantResponse.replace(/\[TITLE\].*?\[\/TITLE\]|<TITLE>.*?<\/TITLE>/g, '').trim();
            } else {
              // Auto-generate title as fallback
              const firstUserMessage = messages.filter(m => m && m.role).find((m: any) => m.role === 'user')?.content;
              conversationTitle = autoGenerateTitle(assistantResponse, firstUserMessage);
              console.log(`[Alia/Chat] No title found in response - auto-generated: "${conversationTitle}"`);
            }
          }

          // Handle canvas tool results - persist and emit via Socket.IO
          if (chunk.type === 'tool-result' && (chunk as any).toolName === 'canvas' && (chunk as any).result) {
            const component = (chunk as any).result;
            if (conversationId && req.user?.id) {
              CanvasSession.findOneAndUpdate(
                { oxyUserId: req.user.id, conversationId },
                { $push: { components: { ...component, createdAt: new Date() } } },
                { upsert: true, new: true }
              ).catch(err => console.error('[Alia/Chat] Canvas save error:', err));
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

      // Flush any remaining text
      flushTextBuffer();

      // Clear timers after successful streaming
      if (streamTimeout) clearTimeout(streamTimeout);
      if (batchTimer) clearTimeout(batchTimer);

      // Check if we got any response
      if (!hasReceivedContent) {
        console.error('[Alia/Chat] Stream completed but no content was received');
        const errorEvent = {
          type: 'error',
          error: 'No response received from AI model. Please try again.'
        };
        console.log('[Alia/Chat] Sending empty stream error to client');
        writeSSE(res, `data: ${JSON.stringify(errorEvent)}\n\n`);
      }
    } catch (streamError: any) {
      console.error('[Alia/Chat] Error during streaming:', streamError);
      console.error('[Alia/Chat] Stream error stack:', streamError.stack);

      // Clean up timers
      if (streamTimeout) clearTimeout(streamTimeout);
      if (batchTimer) clearTimeout(batchTimer);
      flushTextBuffer(); // Try to flush any pending text

      if (!res.writableEnded) {
        const errorEvent = {
          type: 'error',
          error: streamError.message || 'An error occurred while streaming the response'
        };
        console.log('[Alia/Chat] Sending stream error to client:', errorEvent.error);
        writeSSE(res, `data: ${JSON.stringify(errorEvent)}\n\n`);
      }

      // Still try to refund credits if there was an error
      if (creditReservation && req.user) {
        try {
          await refundReservation(creditReservation);
          console.log('[Alia/Chat] Credits refunded due to streaming error');
        } catch (refundError) {
          console.error('[Alia/Chat] Error refunding credits:', refundError);
        }
      }

      throw streamError; // Re-throw to be caught by outer try-catch
    }

    // Finalize credits based on actual token usage and model tier
    if (creditReservation && req.user) {
      try {
        console.log('[Alia/Chat] About to finalize credits with token usage:', tokenUsage);
        const { creditsCharged, creditsRemaining } = await finalizeCredits(
          creditReservation,
          tokenUsage,
          resolved?.aliasModelId
        );

        console.log('[Alia/Chat] Credits finalized successfully:', { creditsCharged, creditsRemaining });

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
        console.log('[Alia/Chat] Sending credit update event:', creditUpdate);
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
          console.error('[Alia/Chat] Error recording usage:', err)
        );
      } catch (error) {
        console.error('[Alia/Chat] Error finalizing credits:', error);
      }
    } else {
      console.log('[Alia/Chat] Skipping credit finalization:', {
        hasCreditReservation: !!creditReservation,
        hasUser: !!req.user
      });
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
    }).catch(err => console.error('[Alia/Chat] Error in afterChat hooks:', err));

    // Auto-save conversation if conversationId provided and user is authenticated
    if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user && assistantResponse) {
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
          }
        ].filter(msg => msg != null && msg.role && msg.content !== undefined);

        // Use extracted/auto-generated title, or generate one as final fallback
        const firstUserMessage = allMessages.filter(m => m && m.role).find((m: any) => m.role === 'user')?.content;
        const title = conversationTitle || autoGenerateTitle(assistantResponse, firstUserMessage);
        const lastMessage = assistantResponse.slice(0, 100);

        console.log(`[Alia/Chat] Saving conversation ${conversationId} with title: "${title}"`);

        // Save or update conversation
        await Conversation.findOneAndUpdate(
          { oxyUserId: req.user.id, conversationId: conversationId },
          {
            $set: {
              title,
              lastMessage,
              messages: allMessages,
              updatedAt: new Date()
            },
            $setOnInsert: {
              oxyUserId: req.user.id,
              conversationId: conversationId,
              source: platform,
              createdAt: new Date()
            }
          },
          { upsert: true, new: true }
        );

        console.log(`[Alia/Chat] Conversation ${conversationId} saved successfully`);
      } catch (error) {
        console.error('[Alia/Chat] Error saving conversation:', error);
        console.error('[Alia/Chat] ConversationId:', conversationId);
        // Don't fail the request if saving fails
      }
    } else if (!conversationId && req.user) {
      console.warn('[Alia/Chat] ConversationId not provided - conversation will not be saved');
    }

    // Send completion marker
    writeSSE(res, 'data: [DONE]\n\n');
    res.end();
    clearTimeout(requestTimeout);

  } catch (e: any) {
    console.error('[Alia/Chat] Error:', e);
    clearTimeout(requestTimeout);

    // Refund credits if request failed
    if (creditReservation && req.user) {
      try {
        await refundReservation(creditReservation);
        console.log('[Alia/Chat] Credits refunded due to error');
      } catch (refundError) {
        console.error('[Alia/Chat] Error refunding credits:', refundError);
      }
    }

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
      getTimeline: true,
      searchKnowledgeBase: true,
      scrapeURL: true
    }
  });
});

export default router;
