// Internal Alia Chat API - Simple streaming endpoint
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { Router } from 'express';
import { streamText, stepCountIs, type ToolSet } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { loadKeys } from '../lib/load-balancer.js';
import { resolveAliaModel, getDefaultAliaModel } from '../lib/model-resolver.js';
import type { KeyConfig } from '../lib/types.js';
import { getCurrentDateTool, createGoogleSearchTool, getTimelineTool, searchKnowledgeBaseTool, scrapeURLTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createGetDeviceInfoTool, createSendTelegramTool, type DeviceInfo } from '../lib/tools/index.js';
import { optionalAuth, oxyClient } from '../middleware/auth.js';
import type { User as OxyUser } from '@oxyhq/services';
import { UserCredits } from '../models/user-credits.js';
import { UserMemory } from '../models/user-memory.js';
import { Conversation } from '../models/conversation.js';
import type { IUserMemory } from '../models/user-memory.js';
import { processMessagesForPlatform } from '../lib/message-processor.js';
import { reserveCredits, finalizeCredits, refundReservation, type CreditReservation, type CreditUsage } from '../lib/credits-manager.js';

const router = Router();

// Auto-generate a title from response content if AI didn't provide one
function autoGenerateTitle(content: string, userMessage?: string): string {
  const extractWords = (text: string): string => {
    const cleaned = text.replace(/\[.*?\]|[#*_`]/g, '').trim();
    if (cleaned.length < 10) return '';
    const words = cleaned.split(/\s+/).slice(0, 6);
    return words.join(' ');
  };

  // Try assistant response first, then user message, then default
  return extractWords(content) || extractWords(userMessage || '') || 'Nueva conversación';
}

// Create AI SDK provider based on key
function getAIModel(keyConfig: KeyConfig) {
  const apiKey = keyConfig.key;
  const modelId = keyConfig.modelId;

  switch (keyConfig.provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId || 'gemini-2.5-flash');
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai(modelId || 'gpt-4o-mini');
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId || 'claude-sonnet-4-20250514');
    }
    case 'groq': {
      const groq = createOpenAI({
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1'
      });
      return groq(modelId || 'llama-3.3-70b-versatile');
    }
    case 'together': {
      const together = createOpenAI({
        apiKey,
        baseURL: 'https://api.together.ai/v1'
      });
      return together(modelId || 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
    }
    case 'cerebras': {
      const cerebras = createOpenAI({
        apiKey,
        baseURL: 'https://api.cerebras.ai/v1'
      });
      return cerebras(modelId || 'llama-3.3-70b');
    }
    default:
      throw new Error(`Provider "${keyConfig.provider}" not supported for Alia chat`);
  }
}

// Function to build personalized system prompt
function buildSystemPrompt(oxyUser?: OxyUser | null, memory?: IUserMemory | null, platform: 'app' | 'telegram' = 'app'): string {
  let prompt = ALIA_SYSTEM_PROMPT;

  if (platform === 'telegram') {
    prompt = ALIA_TELEGRAM_PROMPT;
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

  // Add memory preferences and context
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
    if (memory.memories?.length) {
      const memoryItems = memory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
      userContext.push(`\nThings to remember about the user:\n${memoryItems}`);
    }
  }

  if (userContext.length > 0) {
    console.log('[Alia/Chat] Personalization applied:', userContext);
    prompt = `# USER CONTEXT\n\n${userContext.join('\n')}\n\n---\n\n${prompt}`;
  }

  return prompt;
}

// Telegram-specific system prompt (simplified, no visual components)
const ALIA_TELEGRAM_PROMPT = `You are Alia, the AI assistant for Alia AI platform. You connect users to powerful AI models (Gemini, Claude, GPT-4, etc).

**MANDATORY: EVERY response must end with \`[TITLE]Short Title[/TITLE]\` (max 6 words). NO EXCEPTIONS.**

**Language Rule**: ALWAYS respond in the same language the user writes. If unclear, use their account language preference. Match their language automatically.

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

const ALIA_SYSTEM_PROMPT = `You are Alia, AI assistant for Alia AI platform. You connect users to powerful AI models (Gemini, Claude, GPT-4, etc). Platform offers OpenAI-compatible API at \`/api/v1\`.

**MANDATORY: EVERY response must end with \`[TITLE]Short Title[/TITLE]\` (max 6 words). NO EXCEPTIONS.**

**Language Rule**: ALWAYS respond in the same language the user writes. If unclear, use their account language preference. Match their language automatically.

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

  try {
    const { messages, conversationId, model: requestedModel } = req.body as { messages: any[]; conversationId?: string; model?: string };

    if (!messages || !messages.length) {
      clearTimeout(requestTimeout);
      res.status(400).json({ error: 'No messages provided' });
      return;
    }

    console.log('[Alia/Chat] Request received, loading keys...');

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
    let creditReservation: CreditReservation | null = null;

    if (req.user) {
      try {
        console.log('[Alia/Chat] Loading user data...');

        // Get or create local credits record
        userCredits = await UserCredits.findByIdAndUpdate(
          req.user.id,
          {
            $setOnInsert: {
              _id: req.user.id,
              credits: { free: 1000, freeLimit: 1000, dailyRefresh: 300, lastRefresh: new Date(), paid: 0 },
            },
          },
          { upsert: true, new: true }
        );

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

        // Refresh credits if needed
        await userCredits.refreshCreditsIfNeeded();

        // Reserve credits using centralized manager
        creditReservation = await reserveCredits(req.user.id);

        if (!creditReservation) {
          console.log('[Alia/Chat] Insufficient credits');
          clearTimeout(requestTimeout);
          res.status(402).json({
            error: 'Insufficient credits',
            credits: 0
          });
          return;
        }

        console.log('[Alia/Chat] User data loaded successfully');
      } catch (error) {
        console.error('[Alia/Chat] Error fetching user data:', error);
      }
    }

    let keyPool;
    let resolved;

    try {
      console.log('[Alia/Chat] Loading API keys...');
      keyPool = await loadKeys();
      console.log(`[Alia/Chat] Loaded ${keyPool.length} keys`);

      const aliasModelId = requestedModel || getDefaultAliaModel();
      resolved = await resolveAliaModel(aliasModelId, keyPool);
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

    const googleApiKey = keyPool.find(k => k.provider === 'google')?.key || null;
    const tools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      getTimeline: getTimelineTool,
      searchKnowledgeBase: searchKnowledgeBaseTool,
      scrapeURL: scrapeURLTool,
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

    // Build personalized system prompt
    const systemPrompt = buildSystemPrompt(oxyUser, memory, platform);

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
    };

    const result = streamText({
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
          };
          console.log('[Alia/Chat] Token usage captured:', tokenUsage);
        } else {
          console.warn('[Alia/Chat] No usage data available from AI SDK');
        }
      },
    });

    // Stream all events including tool calls
    let assistantResponse = '';
    let conversationTitle: string | null = null;
    let hasReceivedContent = false;
    let streamTimeout: NodeJS.Timeout | null = null;

    // Set a timeout for stream inactivity (30 seconds without any content)
    const resetStreamTimeout = () => {
      if (streamTimeout) clearTimeout(streamTimeout);
      streamTimeout = setTimeout(() => {
        if (!hasReceivedContent && !res.writableEnded) {
          console.error('[Alia/Chat] Stream timeout - no content received in 30s');
          const errorEvent = {
            type: 'error',
            error: 'Stream timeout - the AI model did not respond in time. Please try again.'
          };
          res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 30000);
    };

    resetStreamTimeout();

    try {
      for await (const chunk of result.fullStream) {
        // Mark that we've received content
        if (chunk.type === 'text-delta' || chunk.type === 'tool-call') {
          hasReceivedContent = true;
          if (streamTimeout) clearTimeout(streamTimeout);
        }

        // Collect assistant response text for saving
        if (chunk.type === 'text-delta') {
          assistantResponse += chunk.text;
        }

        // Extract title if present in response
        if (chunk.type === 'finish' && assistantResponse) {
          const titleMatch = assistantResponse.match(/\[TITLE\](.*?)\[\/TITLE\]/);
          if (titleMatch) {
            conversationTitle = titleMatch[1].trim();
            console.log(`[Alia/Chat] Extracted title: "${conversationTitle}"`);
            // Remove title tags from response
            assistantResponse = assistantResponse.replace(/\[TITLE\].*?\[\/TITLE\]/g, '').trim();
          } else {
            // Auto-generate title as fallback
            const firstUserMessage = messages.filter(m => m && m.role).find((m: any) => m.role === 'user')?.content;
            conversationTitle = autoGenerateTitle(assistantResponse, firstUserMessage);
            console.log(`[Alia/Chat] No title found in response - auto-generated: "${conversationTitle}"`);
          }
        }

        // Send each event as SSE
        const event = JSON.stringify(chunk);
        res.write(`data: ${event}\n\n`);
      }

      // Clear the timeout after successful streaming
      if (streamTimeout) clearTimeout(streamTimeout);

      // Check if we got any response
      if (!hasReceivedContent) {
        console.error('[Alia/Chat] Stream completed but no content was received');
        const errorEvent = {
          type: 'error',
          error: 'No response received from AI model. Please try again.'
        };
        console.log('[Alia/Chat] Sending empty stream error to client');
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      }
    } catch (streamError: any) {
      console.error('[Alia/Chat] Error during streaming:', streamError);
      console.error('[Alia/Chat] Stream error stack:', streamError.stack);
      if (streamTimeout) clearTimeout(streamTimeout);

      if (!res.writableEnded) {
        const errorEvent = {
          type: 'error',
          error: streamError.message || 'An error occurred while streaming the response'
        };
        console.log('[Alia/Chat] Sending stream error to client:', errorEvent.error);
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
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

        const creditUpdate = {
          type: 'credit-update',
          credits: creditsRemaining,
          creditsUsed: creditsCharged,
          totalTokens: tokenUsage.totalTokens,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
        };
        console.log('[Alia/Chat] Sending credit update event:', creditUpdate);
        res.write(`data: ${JSON.stringify(creditUpdate)}\n\n`);
      } catch (error) {
        console.error('[Alia/Chat] Error finalizing credits:', error);
      }
    } else {
      console.log('[Alia/Chat] Skipping credit finalization:', {
        hasCreditReservation: !!creditReservation,
        hasUser: !!req.user
      });
    }

    // Auto-save conversation if conversationId provided and user is authenticated
    if (conversationId && req.user && assistantResponse) {
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
        ].filter(msg => msg != null && msg.role && msg.content !== undefined); // Filter out invalid messages

        // Use extracted/auto-generated title, or generate one as final fallback
        const firstUserMessage = allMessages.filter(m => m && m.role).find((m: any) => m.role === 'user')?.content;
        const title = conversationTitle || autoGenerateTitle(assistantResponse, firstUserMessage);
        const lastMessage = assistantResponse.slice(0, 100);

        console.log(`[Alia/Chat] Saving conversation with title: "${title}"`);

        // Save or update conversation (set source only on insert)
        await Conversation.findOneAndUpdate(
          { oxyUserId: req.user.id, conversationId },
          {
            $set: {
              oxyUserId: req.user.id,
              conversationId,
              title,
              lastMessage,
              messages: allMessages,
              updatedAt: new Date()
            },
            $setOnInsert: {
              source: platform // 'telegram' or 'app'
            }
          },
          { upsert: true, new: true }
        );

        console.log(`[Alia/Chat] Conversation ${conversationId} saved successfully`);
      } catch (error) {
        console.error('[Alia/Chat] Error saving conversation:', error);
        // Don't fail the request if saving fails
      }
    }

    // Send completion marker
    res.write('data: [DONE]\n\n');
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
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

router.get('/', async (req, res) => {
  try {
    const keyPool = await loadKeys();
    const googleApiKey = keyPool.find(k => k.provider === 'google')?.key || null;

    res.json({
      status: '🟢 Online',
      service: 'Alia AI Chat',
      tools: {
        getCurrentDate: true,
        googleSearch: !!googleApiKey,
        getTimeline: true,
        searchKnowledgeBase: true,
        scrapeURL: true
      }
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
