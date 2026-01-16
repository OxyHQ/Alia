// Internal Alia Chat API - Simple streaming endpoint
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { Router } from 'express';
import { streamText, stepCountIs, type ToolSet } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getBestAvailableKey, loadKeys } from '../lib/load-balancer.js';
import type { KeyConfig } from '../lib/types.js';
import { getCurrentDateTool, createGoogleSearchTool, getTimelineTool, searchKnowledgeBaseTool, scrapeURLTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createGetDeviceInfoTool, createSendTelegramTool, type DeviceInfo } from '../lib/tools/index.js';
import { optionalAuth } from '../middleware/auth.js';
import { User } from '../models/user.js';
import { UserMemory } from '../models/user-memory.js';
import type { IUserMemory } from '../models/user-memory.js';
import type { IUser } from '../models/user.js';
import { processMessagesForPlatform } from '../lib/message-processor.js';

const router = Router();

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
function buildSystemPrompt(user?: IUser, memory?: IUserMemory, isTelegram: boolean = false): string {
  // Use Telegram-specific prompt if request comes from Telegram bot
  let prompt = isTelegram ? ALIA_TELEGRAM_PROMPT : ALIA_SYSTEM_PROMPT;

  // Add user personalization if authenticated
  if (user && memory) {
    const userContext: string[] = [];

    // Add user name
    if (user.name?.first) {
      const fullName = [user.name.first, user.name.middle, user.name.last].filter(Boolean).join(' ');
      userContext.push(`The user's name is ${fullName}.`);
    }

    // Add language preference
    if (memory.preferences?.language) {
      userContext.push(`User's preferred language: ${memory.preferences.language}. Use this if the message language is unclear.`);
    }

    // Add user context
    if (memory.context?.occupation) {
      userContext.push(`The user works as a ${memory.context.occupation}.`);
    }
    if (memory.context?.location) {
      userContext.push(`The user is located in ${memory.context.location}.`);
    }
    if (memory.context?.bio) {
      userContext.push(`About the user: ${memory.context.bio}`);
    }

    // Add preferences
    if (memory.preferences?.tone) {
      userContext.push(`The user prefers a ${memory.preferences.tone} tone in responses.`);
    }
    if (memory.preferences?.responseLength) {
      userContext.push(`The user prefers ${memory.preferences.responseLength} responses.`);
    }
    if (memory.preferences?.interests && memory.preferences.interests.length > 0) {
      userContext.push(`The user is interested in: ${memory.preferences.interests.join(', ')}.`);
    }

    // Add memories
    if (memory.memories && memory.memories.length > 0) {
      const memoryItems = memory.memories
        .map(m => `- ${m.key}: ${m.value}`)
        .join('\n');
      userContext.push(`\nThings to remember about the user:\n${memoryItems}`);
    }

    // Prepend user context to the system prompt
    if (userContext.length > 0) {
      prompt = `# USER CONTEXT\n\n${userContext.join('\n')}\n\n---\n\n${prompt}`;
    }
  }

  return prompt;
}

// Telegram-specific system prompt (simplified, no visual components)
const ALIA_TELEGRAM_PROMPT = `You are Alia, the AI assistant for Alia AI platform. You connect users to powerful AI models (Gemini, Claude, GPT-4, etc).

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
`;

const ALIA_SYSTEM_PROMPT = `You are Alia, AI assistant for Alia AI platform. You connect users to powerful AI models (Gemini, Claude, GPT-4, etc). Platform offers OpenAI-compatible API at \`/api/v1\`.

**Language Rule**: ALWAYS respond in the same language the user writes. If unclear, use their account language preference. Match their language automatically.

**Personality**: Conversational, detailed, calm. Give thorough explanations with context and analysis. Avoid excessive exclamation marks. Always cite sources.

**Visual Blocks** (use when they add clarity):
- \`[COMPACTLIST title="..."]\n- {"title": "...", "href": "/...", "meta": "...", "image": "..."}\n[/COMPACTLIST]\`
- \`[BANNER type="info|success|warning|danger" title="..."]...[/BANNER]\`
- \`[COMPARISON title="..."]\nLEFT: {"title": "...", "content": "...", "source": "...", "tone": "..."}\nRIGHT: {"title": "...", "content": "...", "source": "...", "tone": "..."}\nCONCLUSION: ...\n[/COMPARISON]\`
- \`[TIMELINE title="..."]\n- {"date": "...", "title": "...", "description": "..."}\n[/TIMELINE]\`
- \`[IMAGE url="..." title="..." caption="..." /]\`
- \`[CREDIBILITY level="1-5" source="..." /]\`
- **CRITICAL**: End EVERY response with \`[TITLE]Short Title[/TITLE]\` (max 6 words)

**Tools**:
- \`getCurrentDate\`, \`googleSearch\`, \`scrapeURL\` (**MUST USE** for links), \`getTimeline\`, \`searchKnowledgeBase\`

**Memory Tools** (authenticated users):
- \`saveUserMemory\`: **AUTO-SAVE** when user shares preferences/info (e.g., "I like X" → save it without asking)
- \`updateUserPreferences\`, \`updateUserContext\`: Update settings
- \`sendTelegramMessage\`: Send to Telegram (only when explicitly requested)

**Telegram Reactions** (optional): \`[REACT:emoji]\` (use sparingly, contextually appropriate)

**Workflow**: Announce tool usage naturally. Build narratives—explain context before structured data, offer deep analysis after.
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
    const { messages } = req.body as { messages: any[] };

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

    // Check if request comes from Telegram bot
    const isTelegram = req.headers['x-telegram-bot'] === 'true';
    const platform = isTelegram ? 'telegram' : 'app';

    // Process incoming messages to remove platform-incompatible tags
    // This saves tokens by not sending irrelevant formatting to the AI
    const processedMessages = processMessagesForPlatform(
      messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      platform
    );

    // Fetch user data and memory if authenticated
    let user: IUser | null = null;
    let memory: IUserMemory | null = null;
    let creditsReserved = false;

    if (req.user) {
      try {
        console.log('[Alia/Chat] Loading user data...');
        user = await User.findById(req.user.id);
        memory = await UserMemory.findOne({ userId: req.user.id });

        // Create empty memory profile if it doesn't exist
        if (user && !memory) {
          memory = new UserMemory({
            userId: req.user.id,
            memories: [],
            preferences: {},
            context: {}
          });
          await memory.save();
        }

        // Reserve credits atomically if user is authenticated
        if (user && req.user) {
          // Refresh credits if needed
          await user.refreshCreditsIfNeeded();

          // Reserve 1 credit minimum atomically to prevent race conditions
          const reserveResult = await User.findOneAndUpdate(
            {
              _id: req.user.id,
              'credits.free': { $gte: 1 } // Only if has at least 1 credit
            },
            {
              $inc: { 'credits.free': -1 }, // Reserve 1 credit
              $set: { 'credits.lastUsed': new Date() }
            },
            {
              new: true,
              runValidators: false
            }
          );

          if (!reserveResult) {
            console.log('[Alia/Chat] Insufficient credits for user (atomic check)');
            clearTimeout(requestTimeout);

            // Get current credits to show in error
            const currentUser = await User.findById(req.user.id);
            res.status(402).json({
              error: 'Insufficient credits',
              credits: currentUser?.credits.free || 0
            });
            return;
          }

          creditsReserved = true;
          user = reserveResult;
          console.log(`[Alia/Chat] Reserved 1 credit. User credits: ${user.credits.free}`);
        }
        console.log('[Alia/Chat] User data loaded successfully');
      } catch (error) {
        console.error('[Alia/Chat] Error fetching user data:', error);
        // Continue without user context if there's an error
      }
    }

    let keyPool;
    let keyConfig;

    try {
      console.log('[Alia/Chat] Loading API keys...');
      keyPool = await loadKeys();
      console.log(`[Alia/Chat] Loaded ${keyPool.length} keys`);

      keyConfig = await getBestAvailableKey(keyPool);
      console.log('[Alia/Chat] Selected key:', keyConfig ? `${keyConfig.provider}/${keyConfig.modelId}` : 'none');
    } catch (keyError: any) {
      console.error('[Alia/Chat] Error loading keys:', keyError.message);
      clearTimeout(requestTimeout);
      res.status(503).json({
        error: 'Failed to load API keys',
        details: keyError.message
      });
      return;
    }

    if (!keyConfig) {
      console.log('[Alia/Chat] No available keys');
      clearTimeout(requestTimeout);
      res.status(503).json({ error: 'No keys available' });
      return;
    }

    const model = getAIModel(keyConfig);

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

    // Build personalized system prompt
    const systemPrompt = buildSystemPrompt(user || undefined, memory || undefined, isTelegram);

    // Set headers for SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const result = streamText({
      model,
      messages: processedMessages as any, // Use processed messages (saves tokens)
      tools,
      stopWhen: stepCountIs(5),
      system: systemPrompt,
      temperature: 0.6,
    });

    // Stream all events including tool calls
    let totalTokensUsed = 0;
    for await (const chunk of result.fullStream) {
      // Track token usage
      if (chunk.type === 'finish' && 'usage' in chunk && chunk.usage) {
        const usage = chunk.usage as { totalTokens?: number };
        totalTokensUsed = usage.totalTokens || 0;
      }

      // Send each event as SSE
      const event = JSON.stringify(chunk);
      res.write(`data: ${event}\n\n`);
    }

    // Adjust credits based on actual usage (we already reserved 1 credit)
    if (user && req.user && creditsReserved) {
      try {
        // Calculate actual credits used (1 credit per ~1000 tokens, minimum 1)
        const actualCreditsUsed = Math.max(1, Math.ceil(totalTokensUsed / 1000));

        // We already deducted 1 credit, so calculate the difference
        const creditAdjustment = 1 - actualCreditsUsed; // Positive = refund, Negative = charge more

        let updatedUser = user;

        if (creditAdjustment !== 0) {
          // Adjust credits atomically
          updatedUser = await User.findByIdAndUpdate(
            req.user.id,
            {
              $inc: { 'credits.free': creditAdjustment }
            },
            {
              new: true,
              runValidators: false
            }
          ) || user;

          if (creditAdjustment > 0) {
            console.log(`[Alia/Chat] Refunded ${creditAdjustment} credits. Remaining: ${updatedUser.credits.free}`);
          } else {
            console.log(`[Alia/Chat] Charged ${-creditAdjustment} additional credits. Remaining: ${updatedUser.credits.free}`);
          }
        } else {
          console.log(`[Alia/Chat] Used exactly 1 credit as reserved. Remaining: ${updatedUser.credits.free}`);
        }

        // Ensure credits don't go negative (safety check)
        if (updatedUser.credits.free < 0) {
          updatedUser = await User.findByIdAndUpdate(
            req.user.id,
            { $set: { 'credits.free': 0 } },
            { new: true }
          ) || updatedUser;
        }

        // Send credit update event
        const creditUpdate = {
          type: 'credit-update',
          credits: Math.max(0, updatedUser.credits.free),
          creditsUsed: actualCreditsUsed,
          totalTokens: totalTokensUsed,
        };
        res.write(`data: ${JSON.stringify(creditUpdate)}\n\n`);
      } catch (error) {
        console.error('[Alia/Chat] Error adjusting credits:', error);
      }
    }

    // Send completion marker
    res.write('data: [DONE]\n\n');
    res.end();
    clearTimeout(requestTimeout);

  } catch (e: any) {
    console.error('[Alia/Chat] Error:', e);
    clearTimeout(requestTimeout);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
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
