/**
 * Internal Service Trigger Endpoint
 *
 * Allows internal Oxy ecosystem services (Inbox, Calendar, etc.) to trigger
 * autonomous Alia AI processing on behalf of users using service tokens.
 *
 * Auth: Service tokens only (via oxyClient.serviceAuth())
 * No credits charged (platform cost)
 */

import { Router } from 'express';
import { generateText, stepCountIs, type ToolSet } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel, reportModelUsage } from '../lib/chat-core.js';
import {
  getCurrentDateTool,
  createGoogleSearchTool,
  saveUserMemoryTool,
  updateUserPreferencesTool,
  updateUserContextTool,
  createSendTelegramTool,
  scrapeURLTool,
} from '../lib/tools/index.js';
import { oxyServiceAuth, oxyClient } from '../middleware/auth.js';
import type { User as OxyUser } from '@oxyhq/core';
import { UserMemory } from '../models/user-memory.js';
import type { IUserMemory } from '../models/user-memory.js';
import { recordUsage } from '../middleware/api-key-rate-limit.js';

const router = Router();

/**
 * Build a system prompt for autonomous trigger processing.
 * Simpler than the chat prompt — no visual blocks, no title generation.
 */
function buildTriggerSystemPrompt(
  oxyUser?: OxyUser | null,
  memory?: IUserMemory | null,
  appName?: string
): string {
  const userContext: string[] = [];

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
  }

  if (memory) {
    if (memory.preferences?.language) {
      userContext.push(`User's preferred language: ${memory.preferences.language}.`);
    }
    if (memory.context?.occupation) {
      userContext.push(`The user works as a ${memory.context.occupation}.`);
    }
    if (memory.context?.location && !oxyUser?.location) {
      userContext.push(`The user is located in ${memory.context.location}.`);
    }
    if (memory.preferences?.tone) {
      userContext.push(`The user prefers a ${memory.preferences.tone} tone.`);
    }
    if (memory.memories?.length) {
      const memoryItems = memory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
      userContext.push(`\nThings to remember about the user:\n${memoryItems}`);
    }
  }

  let prompt = `You are Alia, an autonomous AI assistant for the Oxy ecosystem.

You are being triggered by an internal service (${appName || 'unknown'}) to process an event on behalf of a user. You should analyze the event and decide what actions to take.

Available actions:
- Send the user a Telegram notification (use sendTelegramMessage tool) if the event is important or urgent
- Save relevant information to user memory (use saveUserMemory tool) for future reference
- Update user preferences or context if you learn something new about the user

Guidelines:
- Be concise and helpful in any notifications you send
- Only send Telegram notifications for genuinely important or time-sensitive events
- Use the user's preferred language if known
- Do NOT send a notification if the event is routine or low-priority unless the user has specifically requested it
- Always respond with a brief summary of what you decided to do and why`;

  if (userContext.length > 0) {
    prompt = `# USER CONTEXT\n\n${userContext.join('\n')}\n\n---\n\n${prompt}`;
  }

  return prompt;
}

/**
 * POST /internal/trigger
 *
 * Process an autonomous AI trigger from an internal service.
 *
 * Headers:
 *   Authorization: Bearer <service-token>
 *   X-Oxy-User-Id: <userId>  (delegated user)
 *
 * Body:
 *   {
 *     event: string,          // e.g., "email.received", "calendar.reminder"
 *     data: object,           // Event-specific payload
 *     instructions?: string,  // Optional custom instructions for the AI
 *   }
 */
router.post('/trigger', oxyServiceAuth, async (req, res) => {
  const startTime = Date.now();

  try {
    const { event, data, instructions } = req.body as {
      event: string;
      data?: Record<string, any>;
      instructions?: string;
    };

    if (!event) {
      res.status(400).json({ error: 'event is required' });
      return;
    }

    const userId = req.userId;
    const appName = req.serviceApp?.appName;

    if (!userId) {
      res.status(400).json({
        error: 'X-Oxy-User-Id header is required for trigger requests',
      });
      return;
    }

    console.log(`[Internal/Trigger] event=${event} app=${appName} user=${userId}`);

    // Load user memory
    let memory: IUserMemory | null = null;
    try {
      memory = await UserMemory.findOne({ oxyUserId: userId });
    } catch (error) {
      console.error('[Internal/Trigger] Error loading user memory:', error);
    }

    // Load Oxy user profile for personalization
    let oxyUser: OxyUser | null = null;
    try {
      oxyUser = await oxyClient.getUserById(userId) as OxyUser;
    } catch (error) {
      console.log('[Internal/Trigger] Could not fetch Oxy user profile:', error);
    }

    // Resolve AI model
    const resolved = await resolveModel(getDefaultAliaModel());
    if (!resolved) {
      res.status(503).json({
        error: 'No AI models available',
        details: 'All models are currently unavailable. Please try again later.',
      });
      return;
    }

    const model = getAIModel(resolved.keyConfig);
    const googleApiKey = resolved.keyConfig.provider === 'google' ? resolved.keyConfig.key : null;

    // Build tools — authenticated user tools + general tools
    const tools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      scrapeURL: scrapeURLTool,
      ...(googleApiKey ? { googleSearch: createGoogleSearchTool(googleApiKey) } : {}),
      saveUserMemory: saveUserMemoryTool(userId),
      updateUserPreferences: updateUserPreferencesTool(userId),
      updateUserContext: updateUserContextTool(userId),
      sendTelegramMessage: createSendTelegramTool(userId),
    };

    // Build the user message from the event
    const eventDescription = `[Event: ${event}]${data ? `\n\nEvent data:\n${JSON.stringify(data, null, 2)}` : ''}${instructions ? `\n\nAdditional instructions: ${instructions}` : ''}`;

    const systemPrompt = buildTriggerSystemPrompt(oxyUser, memory, appName);

    // Use generateText (non-streaming) for server-to-server
    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: eventDescription },
      ],
      tools,
      temperature: 0.3,
      maxRetries: 0,
      stopWhen: stepCountIs(5),
    } as any);

    const responseTime = Date.now() - startTime;

    // Extract token usage (AI SDK uses inputTokens/outputTokens)
    const tokenUsage = result.usage ? {
      promptTokens: (result.usage as any).inputTokens || 0,
      completionTokens: (result.usage as any).outputTokens || 0,
      totalTokens: result.usage.totalTokens || 0,
    } : null;

    // Report model usage for provider analytics
    if (resolved) {
      await reportModelUsage(
        resolved.keyConfig?.keyId,
        resolved.provider,
        resolved.modelId,
        true,
        responseTime
      );
    }

    // Record usage (no credits charged — platform cost)
    try {
      await recordUsage(
        req,
        200,
        tokenUsage?.totalTokens || 0,
        responseTime,
        0 // no credits charged for internal
      );
    } catch (error) {
      console.error('[Internal/Trigger] Error recording usage:', error);
    }

    // Collect tool call results
    const toolCalls = result.steps?.flatMap((step: any) =>
      (step.toolCalls || []).map((tc: any) => ({
        tool: tc.toolName,
        args: tc.args,
      }))
    ) || [];

    console.log(`[Internal/Trigger] Done event=${event} app=${appName} user=${userId} tools=${toolCalls.length} time=${responseTime}ms`);

    res.json({
      event,
      response: result.text,
      toolCalls,
      usage: tokenUsage,
      responseTime,
    });
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('[Internal/Trigger] Error:', error);

    res.status(500).json({
      error: 'Trigger processing failed',
      details: error instanceof Error ? error.message : 'Unknown error',
      responseTime,
    });
  }
});

export default router;
