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
import { resolveModel, getAIModel, getDefaultAliaModel, reportModelUsage } from '../lib/chat-core.js';
import {
} from '../lib/tools/index.js';
import { oxyServiceAuth, oxyClient } from '../middleware/auth.js';
import { ToolPipeline } from '../lib/tool-pipeline.js';
import { setPlanModelIds } from '../db/billing/planRepository.js';
import { isAliaModel } from '../lib/gateway-client.js';
import type { User as OxyUser } from '@oxyhq/core';
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
      const memoryItems = memory.memories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
      userContext.push(`\nThings to remember about the user:\n${memoryItems}`);
    }
  }

  let prompt = `You are Alia, an autonomous AI assistant for the Oxy ecosystem. You are processing an event from ${appName || 'an internal service'} on behalf of a user.

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
    const resolved = await resolveModel(getDefaultAliaModel());
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
    });

    const responseTime = Date.now() - startTime;

    // Extract token usage (AI SDK uses inputTokens/outputTokens)
    const tokenUsage = result.usage ? {
      promptTokens: result.usage.inputTokens || 0,
      completionTokens: result.usage.outputTokens || 0,
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

/**
 * PUT /internal/plans/:planId/models — which models a plan grants
 * (#139 workstream 14, *"allow the product team to select which Oxy/Relay models
 * are available per plan/surface"*).
 *
 * ## Why the plan, and why only the model list
 *
 * `plans.model_ids` is the input to `lib/plan-access.ts`, which decides whether
 * a request may name a model at all. It is the ONE runtime surface in this
 * repository where "which models are available" is data rather than a commit,
 * and until now it had no writer: the row was hand-editable in the database and
 * nothing recorded who changed it, which
 * `lib/routing/__tests__/routing-config-audit.test.ts` measured and called a
 * gap. This is the writer that closes it.
 *
 * The SURFACE half of that checkbox is not here and must not arrive here.
 * Which entries a picker offers is `lib/product-modes.ts` `VISIBLE_PROFILES` —
 * a `const` in a committed file, whose audit trail is git, exactly like
 * `PRODUCT_MODES` and `ROUTING_PRESETS`. `routing-config-audit.test.ts` asserts
 * no route names it, and that assertion is correct: a second runtime authority
 * for product configuration is what this epic is removing, not adding.
 *
 * ## What it may write
 *
 * `model_ids` and nothing else, as a property of the SIGNATURE rather than of
 * this handler's care: `setPlanModelIds` takes a list, not an updates object,
 * so there is no field to widen and no `req.body` to spread. Price, Stripe
 * identifiers, the plan's own id and its product are all unreachable through
 * here — the mass-assignment shape is absent rather than guarded against.
 *
 * Every identifier is checked against the registered model set before the
 * write. An unregistered id in `model_ids` is not a harmless typo: it grants
 * nothing, and it grants nothing SILENTLY, which is a plan that looks like it
 * sells a model and does not.
 *
 * ## Who may call it
 *
 * `oxyServiceAuth`, like every other route on this router — a verified Oxy
 * service credential and nothing else. Alia has no admin role of its own and
 * inventing one here would be the mass-assignment hazard in a different place.
 * A finer gate belongs in the contract's own vocabulary
 * (`inference:routing:write`, `@oxyhq/contracts` `INFERENCE_SCOPES`) and is not
 * applied yet, because the credential that reaches this router today carries
 * the scope `internal` and nothing else; requiring a scope no reachable
 * credential holds would be a refusal wearing a feature's name.
 */
router.put('/plans/:planId/models', oxyServiceAuth, async (req, res) => {
  const serviceApp = req.serviceApp;
  if (!serviceApp) {
    // `oxyServiceAuth` does not reach here without one. Read rather than
    // asserted, because the actor is REQUIRED by the audit record and a
    // non-null assertion would be the one place it could become `system`.
    res.status(403).json({ error: 'A verified service credential is required' });
    return;
  }

  const planId = req.params.planId;
  const body: unknown = req.body;
  const submitted =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>).model_ids : undefined;

  if (!Array.isArray(submitted) || submitted.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'model_ids must be an array of model identifiers' });
    return;
  }
  const modelIds = submitted as string[];

  // Duplicates are a caller mistake that produces a list whose length lies.
  if (new Set(modelIds).size !== modelIds.length) {
    res.status(400).json({ error: 'model_ids contains duplicates' });
    return;
  }

  const unknownIds: string[] = [];
  for (const id of modelIds) {
    if (!(await isAliaModel(id))) unknownIds.push(id);
  }
  if (unknownIds.length > 0) {
    res.status(400).json({
      error: 'model_ids names identifiers that do not exist',
      // The caller's own input, echoed back. Not through `sanitizeMessage`: it
      // is theirs and reveals nothing about Alia's routing.
      unknown: unknownIds,
    });
    return;
  }

  try {
    const row = await setPlanModelIds(getDb(), planId, modelIds, {
      kind: 'service',
      id: serviceApp.appId,
    });
    if (row === null) {
      res.status(404).json({ error: 'No such plan' });
      return;
    }
    res.json({ plan_id: row.planId, model_ids: row.modelIds });
  } catch (error: unknown) {
    log.general.error({ err: error, planId }, 'Failed to set plan model access');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Could not update plan model access') });
  }
});

export default router;
