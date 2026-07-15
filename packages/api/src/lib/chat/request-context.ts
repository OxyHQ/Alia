/**
 * Pre-flight assembly for /v1/chat/completions: body validation, the parallel
 * prefetch (credits, model, memory, profile, skill, entitlements, linked
 * agent), credit/model/plan gating, and beforeChat hooks.
 *
 * Returns null when a response has already been written (validation error or
 * gate rejection) — the route handler must simply return.
 *
 * Import paths deliberately match the ones the route used inline so the
 * timeout suite's module mocks keep intercepting the same seams.
 */
import type { Request, Response } from 'express';
import { resolveModel, getDefaultAliaModel } from '../chat-core.js';
import { UserMemory, type IUserMemory } from '../../models/user-memory.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import { Conversation } from '../../models/conversation.js';
import { reserveCredits, refundReservation, type CreditReservation } from '../credits-manager.js';
import { getUserEntitlements, type Entitlements } from '../plan-access.js';
import type { OxyUserProfile } from '../system-prompt-builder.js';
import { oxyClient } from '../../middleware/auth.js';
import { Skill } from '../../models/skill.js';
import { runBeforeChatHooks } from '../hooks/index.js';
import { log } from '../logger.js';
import { Agent as AgentModel, type IAgent } from '../../models/agent.js';
import { runAutonomyBeforeChat, type AutonomyRuntimeContext } from '../autonomy/runtime.js';
import type { ChatMessage } from '../message-converter.js';
import type { OpenAITool } from '../tool-converter.js';
import type { SSEWriter } from './sse-writer.js';

interface SkillDoc {
  systemPrompt?: string;
  title?: string;
}

export interface ChatRequestContext {
  body: Record<string, unknown> & {
    model?: string;
    stream?: boolean;
    skillId?: string;
    conversationId?: string;
    tools?: OpenAITool[];
  };
  messages: ChatMessage[];
  conversationId: string | undefined;
  thinkingMode: boolean | undefined;
  agentMode: boolean;
  deepResearch: boolean | undefined;
  includeUsage: boolean;
  isDirectUserSession: boolean;
  requestedModel: string;
  clientContext: string | undefined;
  userMemory: IUserMemory | null;
  oxyUser: OxyUserProfile | null;
  skill: SkillDoc | null;
  entitlements: Entitlements | null;
  linkedAgent: IAgent | null;
  /** Initial values for the handler's retry-mutable state. */
  creditReservation: CreditReservation | null;
  resolved: Awaited<ReturnType<typeof resolveModel>>;
  aliasModelId: string;
  autonomyRuntime: AutonomyRuntimeContext | null;
  recalledMemories: Array<{ title: string; summary: string }> | undefined;
}

export async function buildChatRequestContext(
  req: Request,
  res: Response,
  sse: SSEWriter,
  globalTimer: NodeJS.Timeout,
): Promise<ChatRequestContext | null> {
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
    return null;
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
    return null;
  }

  // Extract optional parameters for Alia internal features
  const conversationId = body.conversationId as string | undefined;
  const thinkingMode = body.thinkingMode as boolean | undefined;
  const agentMode = (body.agentMode as boolean | undefined) ?? false;
  const deepResearch = body.deepResearch as boolean | undefined;
  const streamOptions = body.stream_options as { include_usage?: boolean } | undefined;
  const includeUsage = streamOptions?.include_usage === true;

  log.v1.info({ messageCount: messages.length, conversationId, thinkingMode, agentMode, deepResearch }, 'Processing messages');

  let autonomyRuntime: AutonomyRuntimeContext | null = null;
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
  if (body.stream === true) {
    sse.openEarly();
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
      ? Promise.race<OxyUserProfile | null>([
          oxyClient.getUserById(req.user!.id),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
        ]).catch(() => null)
      : Promise.resolve<OxyUserProfile | null>(null),

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
  const creditReservation = creditResult.reservation;
  if (req.user && !req.serviceApp && !creditReservation && !creditResult.error) {
    clearTimeout(globalTimer);
    const creditError = {
      message: "You've run out of credits. Add more or upgrade your plan to continue.",
      type: 'invalid_request_error',
      param: null,
      code: 'INSUFFICIENT_CREDITS',
    };
    if (sse.sent) {
      sse.writeError(creditError);
    } else {
      res.status(402).json({ error: creditError });
    }
    return null;
  }

  // Validate model resolution
  const resolved = resolvedResult;
  if (!resolved) {
    clearTimeout(globalTimer);
    const noModelsError = {
      message: 'No models available. Please try again.',
      type: 'server_error',
      param: 'model',
      code: 'model_not_available',
    };
    if (sse.sent) {
      sse.writeError(noModelsError);
    } else {
      res.status(503).json({ error: noModelsError });
    }
    return null;
  }

  const aliasModelId = resolved.aliasModelId;
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
      if (sse.sent) {
        sse.writeError(modelError);
      } else {
        res.status(403).json({ error: modelError });
      }
      return null;
    }
  }

  let recalledMemories: Array<{ title: string; summary: string }> | undefined;
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
    recalledMemories = hookResult?.metadata?.recalledMemories as Array<{ title: string; summary: string }> | undefined;
  }

  return {
    body,
    messages,
    conversationId,
    thinkingMode,
    agentMode,
    deepResearch,
    includeUsage,
    isDirectUserSession,
    requestedModel,
    clientContext,
    userMemory,
    oxyUser,
    skill: skill as SkillDoc | null,
    entitlements,
    linkedAgent,
    creditReservation,
    resolved,
    aliasModelId,
    autonomyRuntime,
    recalledMemories,
  };
}
