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
import { generateText, stepCountIs } from 'ai';
import { resolveDefaultModel, getAIModel } from '../lib/chat-core.js';
import { oxyServiceAuth, oxyClient } from '../middleware/auth.js';
import { ToolPipeline } from '../lib/tool-pipeline.js';
import { buildIdentityGuard } from '../lib/identity-guard.js';
import { userContextBlock } from '../lib/user-context.js';
import type { User as OxyUser } from '@oxy.so/core';
import { getDb } from '../db/index.js';
import { findUserMemory, type UserMemoryProfile } from '../db/memory/userMemoryRepository.js';
import { recordUsage } from '../middleware/api-key-rate-limit.js';
import { log } from '../lib/logger.js';
import { getSafeErrorMessage } from '../lib/errors/sanitize.js';

const router = Router();

/**
 * Build a system prompt for autonomous trigger processing.
 * Simpler than the chat prompt — no visual blocks, no title generation.
 */
function buildTriggerSystemPrompt(
  oxyUser?: OxyUser | null,
  memory?: UserMemoryProfile | null,
  appName?: string
): string {
  // Names nobody: `buildIdentityGuard` is prepended above this and owns that.
  const prompt = `You are processing an event from ${appName || 'an internal service'} on behalf of a user, unattended.

## Available Actions

| Tool | Use when... |
|------|-------------|
| \`sendTelegramMessage\` | Event is important or time-sensitive — NOT for routine/low-priority events |
| \`saveUserMemory\` | Event reveals a key fact worth remembering for future conversations |
| \`updateUserPreferences\` / \`updateUserContext\` | You learn something new about the user |

## Guidelines

- Use the user's preferred language if known.
- Be concise in notifications — no filler, just the essential information.
- Do NOT notify for routine events unless the user specifically requested it.
- Respond with a brief summary of what you decided and why.`;

  return `${userContextBlock(oxyUser, memory)}${prompt}`;
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

    log.general.info({ event, appName, userId }, 'Trigger received');

    // Load user memory
    let memory: UserMemoryProfile | null = null;
    try {
      memory = (await findUserMemory(getDb(), userId)) ?? null;
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Error loading user memory');
    }

    // Load Oxy user profile for personalization
    let oxyUser: OxyUser | null = null;
    try {
      oxyUser = await oxyClient.getUserById(userId) as OxyUser;
    } catch (error: unknown) {
      log.general.info({ err: error }, 'Could not fetch Oxy user profile');
    }

    // Resolve AI model
    const resolved = await resolveDefaultModel(userId);
    if (!resolved) {
      res.status(503).json({
        error: 'No AI models available',
        details: 'All models are currently unavailable. Please try again later.',
      });
      return;
    }

    const model = getAIModel(resolved, 'background');
    /**
     * Through the ONE assembler, like every other surface.
     *
     * This was an inline `ToolSet` literal — a fifth assembler that no census
     * over exported function names could see, which is why it outlived the four
     * that had names. It is also why `__tests__/one-assembler.test.ts` counts
     * inline literals and not just exports.
     */
    const { tools } = await ToolPipeline.forUser({
      userId,
      isDirectSession: false,
      // A service token delegates a named end user, and acts for them.
      actsForPerson: true,
      agentMode: false,
      toolsEnabled: true,
      webSearch: true,
      isLocalRuntime: false,
    });

    // Build the user message from the event
    const eventDescription = `[Event: ${event}]${data ? `\n\nEvent data:\n${JSON.stringify(data, null, 2)}` : ''}${instructions ? `\n\nAdditional instructions: ${instructions}` : ''}`;

    /**
     * The identity guard on the fifth composition path.
     *
     * A service-token trigger has no agent of its own, so it speaks as Alia —
     * but it still reaches a model and still answers a person through whatever
     * app delegated the call, so the route secrecy applies exactly as it does
     * in chat. This path had no guard because nothing enumerated it.
     */
    const systemPrompt = `${buildIdentityGuard()}\n\n---\n\n${buildTriggerSystemPrompt(oxyUser, memory, appName)}`;

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
    });

    const responseTime = Date.now() - startTime;

    // Extract token usage (AI SDK uses inputTokens/outputTokens)
    const tokenUsage = result.usage ? {
      promptTokens: result.usage.inputTokens || 0,
      completionTokens: result.usage.outputTokens || 0,
      totalTokens: result.usage.totalTokens || 0,
    } : null;

    // Record usage (no credits charged — platform cost)
    try {
      await recordUsage(
        req,
        200,
        tokenUsage?.totalTokens || 0,
        responseTime,
        0 // no credits charged for internal
      );
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Error recording usage');
    }

    // Collect tool call results
    const toolCalls = result.steps?.flatMap((step: any) =>
      (step.toolCalls || []).map((tc: any) => ({
        tool: tc.toolName,
        args: tc.args,
      }))
    ) || [];

    log.general.info({ event, appName, userId, toolCalls: toolCalls.length, responseTime }, 'Trigger completed');

    res.json({
      event,
      response: result.text,
      toolCalls,
      usage: tokenUsage,
      responseTime,
    });
  } catch (error: unknown) {
    const responseTime = Date.now() - startTime;
    log.general.error({ err: error }, 'Trigger processing failed');

    res.status(500).json({
      error: 'Trigger processing failed',
      details: getSafeErrorMessage(error, 'Trigger processing failed'),
      responseTime,
    });
  }
});

export default router;
