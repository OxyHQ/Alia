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
import { resolveModel, getDefaultAliaModel, type RoutingOptions } from '../chat-core.js';
import { toRoutableAlias } from '../product-modes.js';
import {
  isFallbackPolicy,
  FallbackNotPermittedError,
  UnknownFallbackPolicyError,
  UnregisteredModelError,
} from '../routing/policy.js';
import { getDb } from '../../db/index.js';
import { findUserMemory, type UserMemoryProfile } from '../../db/memory/userMemoryRepository.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import { findConversationAgentById } from '../../db/chat/conversationRepository.js';
import { reserveCredits, refundReservation, type CreditReservation } from '../credits-manager.js';
import { getUserEntitlements, type Entitlements } from '../plan-access.js';
import type { OxyUserProfile } from '../system-prompt-builder.js';
import { oxyClient } from '../../middleware/auth.js';
import { findSkillPrompt } from '../../db/agents/skillRepository.js';
import { runBeforeChatHooks } from '../hooks/index.js';
import { log } from '../logger.js';
import { findAgentById, type AgentRecord } from '../../db/agents/agentRepository.js';
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
    fallbackPolicy?: unknown;
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
  userMemory: UserMemoryProfile | null;
  oxyUser: OxyUserProfile | null;
  skill: SkillDoc | null;
  entitlements: Entitlements | null;
  linkedAgent: AgentRecord | null;
  /** Initial values for the handler's retry-mutable state. */
  creditReservation: CreditReservation | null;
  resolved: Awaited<ReturnType<typeof resolveModel>>;
  aliasModelId: string;
  /**
   * The routing options this request resolved under. Carried on the context so
   * the provider loop's RE-resolve uses the same policy the first resolve did —
   * a retry that quietly widened the policy would be the silent substitution
   * this workstream removes, arriving one attempt later.
   */
  routingOptions: RoutingOptions;
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

  /**
   * `fallbackPolicy` — the request's own answer to ADR 0003 invariant 3.
   *
   * Validated here, before any credits are reserved, because it is a body
   * parameter like `messages` and a mistyped value must not cost the caller a
   * reservation. Absent means `DEFAULT_FALLBACK_POLICY`, which is what every
   * client sends today and is the behaviour they already have.
   */
  if (body.fallbackPolicy !== undefined && !isFallbackPolicy(body.fallbackPolicy)) {
    const policyError = new UnknownFallbackPolicyError(body.fallbackPolicy);
    res.status(policyError.httpStatus).json({
      error: {
        message: policyError.userMessage,
        type: 'invalid_request_error',
        param: 'fallbackPolicy',
        code: policyError.code,
      }
    });
    return null;
  }
  const routingOptions: RoutingOptions = isFallbackPolicy(body.fallbackPolicy)
    ? { fallbackPolicy: body.fallbackPolicy }
    : {};

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
  /**
   * The identifier this request routes on.
   *
   * `profile:*` is the vocabulary `GET /catalogue` publishes and the one a
   * client should send; `toRoutableAlias` turns it into the alias that carries
   * the metadata the rest of this path needs — the credit multiplier
   * `credits-manager.ts` bills on, the entitlement id `plan-access.ts` checks,
   * the tier the fallback engine walks, and the system prompt the id selects.
   * Translating ONCE here, at the boundary, is what keeps every one of those
   * from needing to learn a second vocabulary.
   *
   * A legacy `alia-*` identifier passes through untouched and keeps working,
   * which is what nothing-advertises-them means in practice: every installed
   * `@alia.onl/sdk` and `@alia-codea/cli` copy still resolves.
   *
   * `null` is only ever a `profile:` id no preset defines. That is a caller
   * naming a policy that does not exist, and it is refused HERE rather than
   * downstream, because the resolver's refusal talks about models and would
   * send them to the wrong list.
   */
  const routable = toRoutableAlias(body.model || getDefaultAliaModel());
  if (routable === null) {
    const unknownProfile = {
      message: `"${String(body.model)}" is not a routing profile. List them at GET /catalogue.`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'unknown_routing_profile',
    };
    if (sse.sent) {
      sse.writeError(unknownProfile);
    } else {
      res.status(400).json({ error: unknownProfile });
    }
    return null;
  }
  const requestedModel = routable;

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

    /**
     * Model resolution (includes key loading, rate limit checks, circuit
     * breaker).
     *
     * The catch keeps the two REFUSALS instead of flattening them to `null`.
     * Everything else still becomes `null` and still becomes the same 503 it
     * always did — the discrimination below is additive, and no error that
     * existed before this change reaches it.
     */
    resolveModel(requestedModel, undefined, undefined, routingOptions).catch((err: unknown) => {
      log.v1.error({ err }, 'Error resolving model');
      if (err instanceof UnregisteredModelError || err instanceof FallbackNotPermittedError) return err;
      return null;
    }),

    // User memory
    req.user
      ? findUserMemory(getDb(), req.user.id).then(m => m ?? null).catch(() => null)
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
      ? findSkillPrompt(getDb(), body.skillId).then(skill => skill ?? null).catch(() => null)
      : Promise.resolve(null),

    // User entitlements (plan-based model access) — parallelized to avoid sequential delay
    (req.user && !req.apiKey)
      ? getUserEntitlements(req.user.id).catch(() => null)
      : Promise.resolve(null),

    // Linked agent (for archetype prompt injection — Q&A agents, etc.)
    /**
     * `findConversationAgentById` addresses the PRIMARY KEY, and
     * `conversationId` is the client's business key — so this resolves nothing,
     * exactly as the Mongoose `findById` it replaces did (it threw a CastError
     * on a uuid, which the `.catch` below swallowed). The repository's docblock
     * records why the port keeps it that way rather than quietly switching the
     * agent-escalation branch on.
     */
    (conversationId && isDirectUserSession)
      ? findConversationAgentById(getDb(), conversationId)
          .then(conv => conv?.agentId
            ? findAgentById(getDb(), conv.agentId)
            : null)
          .catch(() => null) as Promise<AgentRecord | null>
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

  /**
   * A refused request is answered by the refusal, not by "no models available".
   *
   * Two distinct outcomes used to arrive here as the same 503: an identifier
   * nobody registered (never a working request) and a genuine provider
   * shortage (retry and it may work). Telling them apart is the point — the
   * first is a 400 naming what was asked for and what exists, the second is
   * untouched below.
   *
   * The reservation is refunded, matching the `MODEL_NOT_IN_PLAN` branch further
   * down, which is the same situation: a request rejected on its `model`
   * parameter after credits were held. The 503 path deliberately keeps its
   * existing behaviour.
   */
  if (resolvedResult instanceof UnregisteredModelError || resolvedResult instanceof FallbackNotPermittedError) {
    if (creditReservation) await refundReservation(creditReservation);
    clearTimeout(globalTimer);
    const refusal = {
      message: resolvedResult.userMessage,
      type: resolvedResult.httpStatus >= 500 ? 'server_error' : 'invalid_request_error',
      param: 'model',
      code: resolvedResult.code,
    };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(resolvedResult.httpStatus).json({ error: refusal });
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
    routingOptions,
    autonomyRuntime,
    recalledMemories,
  };
}
