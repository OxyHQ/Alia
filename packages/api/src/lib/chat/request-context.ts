/**
 * Pre-flight assembly for /v1/chat/completions: body validation, the parallel
 * prefetch (credits, model, memory, profile, entitlements, linked
 * agent), credit/model/plan gating, and beforeChat hooks.
 *
 * Returns null when a response has already been written (validation error or
 * gate rejection) — the route handler must simply return.
 *
 * Import paths deliberately match the ones the route used inline so the
 * timeout suite's module mocks keep intercepting the same seams.
 */
import type { Request, Response } from 'express';
import { resolveModel, getDefaultRoutingProfile, type RoutingOptions } from '../chat-core.js';
import { resolveRequestedModel } from '../routing/model-selection.js';
import type { RequestedModel } from '../routing/model-selection.js';
import {
  USER_RUNTIME_PROVIDER,
  parseUserRuntimeModel,
  userRuntimeCanServe,
  type UserRuntimeSelection,
} from '../inference/user-runtime-bridge.js';
import {
  isFallbackPolicy,
  FallbackNotPermittedError,
  UnknownFallbackPolicyError,
  UnregisteredModelError,
} from '../routing/policy.js';
/**
 * The echo of a caller's own `model` string.
 *
 * `redactUnsafeDetail` and not `sanitizeMessage`, the same choice
 * `UnregisteredModelError` documents: route concealment protects Alia's routing
 * decisions, and a string the caller just sent reveals none of them — running
 * the fuller sanitiser on it only mangles the value the message exists to
 * name. What still applies is the absolute half: a caller can put a credential
 * in that field, and a credential is redacted wherever it appears.
 */
import { redactUnsafeDetail } from '../errors/sanitize.js';
import { getDb } from '../../db/index.js';
import { findUserMemory, type UserMemoryProfile } from '../../db/memory/userMemoryRepository.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import { reserveCredits, refundReservation, type CreditReservation } from '../credits-manager.js';
import { getUserEntitlements, type Entitlements } from '../plan-access.js';
import type { OxyUserProfile } from '../system-prompt-builder.js';
import { oxyClient } from '../../middleware/auth.js';
import { findAgentSkills } from '../../db/agents/agentRepository.js';
import { buildSkillRuntime, type SkillRuntime } from '../skills/runtime.js';
import { runBeforeChatHooks } from '../hooks/index.js';
import { log } from '../logger.js';
import { loadTurnAgent, refusalMessage, refusalStatus } from '../agent-account.js';
import type { HydratedAgent } from '../agent-identity.js';
import { findMcpServerForUser } from '../../db/integrations/mcpServerRepository.js';
import { runAutonomyBeforeChat, type AutonomyRuntimeContext } from '../autonomy/runtime.js';
import type { ChatMessage } from '../message-converter.js';
import type { OpenAITool } from '../tool-converter.js';
import type { SSEWriter } from './sse-writer.js';
import { reasoningEffortOf } from '../observability/requested-model.js';
import type { EffortLevel } from '../reasoning-effort.js';

export interface ChatRequestContext {
  body: Record<string, unknown> & {
    model?: string;
    fallbackPolicy?: unknown;
    stream?: boolean;
    skillIds?: unknown;
    conversationId?: string;
    tools?: OpenAITool[];
    mcpServerId?: unknown;
    agentId?: unknown;
  };
  messages: ChatMessage[];
  conversationId: string | undefined;
  /**
   * How hard this request was asked to think, or `null` for the model's default.
   *
   * Resolved ONCE, at the request boundary, from the three spellings a caller
   * may use — see `lib/observability/requested-model.ts` `reasoningEffortOf`.
   * Nothing downstream carries the `thinkingMode` boolean this replaced.
   */
  reasoningEffort: EffortLevel | null;
  agentMode: boolean;
  deepResearch: boolean | undefined;
  /**
   * Whether Alia may reach the open web for this turn.
   *
   * `true` when the caller said nothing, which is the behaviour every request
   * has had: `lib/tool-pipeline.ts` put `webSearch`, `webScraper` and `browse`
   * in the always-on tool set, and the composer's "Web search" switch reached
   * nothing at all. The switch means something now, and what it means is
   * REMOVAL — a person turning it off gets a turn with no web tools offered to
   * the model, rather than a differently-worded prompt.
   */
  webSearch: boolean;
  /**
   * The hosted MCP connector selected for this turn. Omitted preserves the
   * compatibility path, `null` means none, and a string has been verified as a
   * runnable connector owned by the direct user.
   */
  mcpServerId: string | null | undefined;
  includeUsage: boolean;
  isDirectUserSession: boolean;
  requestedModel: string;
  /**
   * Which personality file the turn speaks with.
   *
   * The same as `routingProfileId` for everything Alia routes, because the prompt
   * belongs to the ROUTING PROFILE and that is what the alias names. A model
   * served by the person's own device has no profile, and naming it here would
   * ask `prompts/local/<runtime>/<model>.md` of the filesystem — a file that
   * cannot exist, whose absence degrades to the base prompt alone. The turn
   * would answer without Alia's personality and nothing would report an error.
   */
  promptModelId: string;
  /**
   * Whether this turn is served by the caller's own device.
   *
   * Carried on the context because the TOOL SET depends on it: a turn that
   * reserved no credits must not be handed a tool that spends them.
   */
  isLocalRuntime: boolean;
  clientContext: string | undefined;
  userMemory: UserMemoryProfile | null;
  oxyUser: OxyUserProfile | null;
  /**
   * The skills this turn may reach, and the tools that reach them.
   *
   * Built once, here, because two consumers need the same read: the system
   * prompt takes its index and any explicitly selected bodies, and the tool
   * pipeline takes its tools. Building it twice would authorize twice.
   */
  skills: SkillRuntime;
  entitlements: Entitlements | null;
  linkedAgent: HydratedAgent | null;
  /**
   * The verified inbound product service token for an application-bound agent.
   * Undefined means the ordinary Alia credential lane. This is selected only
   * after exact application and delegation checks, so `agentId` never chooses
   * the billing principal.
   */
  inferenceServiceToken: string | undefined;
  /** Initial values for the handler's retry-mutable state. */
  creditReservation: CreditReservation | null;
  resolved: Awaited<ReturnType<typeof resolveModel>>;
  routingProfileId: string;
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
  const requestedPolicy = isFallbackPolicy(body.fallbackPolicy) ? body.fallbackPolicy : undefined;

  // Extract optional parameters for Alia internal features
  const conversationId = body.conversationId as string | undefined;
  const agentMode = (body.agentMode as boolean | undefined) ?? false;
  const deepResearch = body.deepResearch as boolean | undefined;
  // Absent means ON, which is what every request did before the switch existed.
  const webSearch = body.webSearch !== false;
  const streamOptions = body.stream_options as { include_usage?: boolean } | undefined;
  const includeUsage = streamOptions?.include_usage === true;

  log.v1.info({ messageCount: messages.length, conversationId, agentMode, deepResearch, webSearch }, 'Processing messages');

  let autonomyRuntime: AutonomyRuntimeContext | null = null;
  if (req.user?.id) {
    autonomyRuntime = await runAutonomyBeforeChat({
      userId: req.user.id,
      messages,
    }).catch(() => null);
  }

  // Determine if this is a direct user session (not API key)
  // API key requests should be neutral and not include creator's personal info
  // A delegated service request has a person in `req.user`, but its principal
  // is still the verified application in `req.serviceApp`. Calling it a direct
  // session would erase the application boundary and expose direct-only
  // context/tools to a machine caller.
  const isDirectUserSession = !!req.user && !req.apiKey && !req.serviceApp;
  const isDelegatedServiceSession =
    !!req.user?.id &&
    !!req.serviceApp &&
    req.serviceActingAs?.userId === req.user.id;

  /**
   * An agent id is an exact identity selector, never a hint.
   *
   * Validate it before opening SSE or reserving credits. API keys cannot select
   * a person's agent because they do not carry the direct user session whose
   * Oxy standing authorises it. Both that case and an unauthenticated direct
   * invocation use the same neutral error as a missing/private agent so this
   * boundary does not disclose whether the id exists.
   */
  let requestedAgentId: string | undefined;
  if (body.agentId !== undefined) {
    if (
      typeof body.agentId !== 'string'
      || body.agentId === ''
      || body.agentId.trim() !== body.agentId
    ) {
      res.status(400).json({
        error: {
          message: 'agentId must be a non-empty agent id.',
          type: 'invalid_request_error',
          param: 'agentId',
          code: 'invalid_agent_id',
        },
      });
      return null;
    }
    if ((!isDirectUserSession && !isDelegatedServiceSession) || !req.user?.id) {
      res.status(404).json({
        error: {
          message: 'The selected agent is unavailable.',
          type: 'invalid_request_error',
          param: 'agentId',
          code: 'agent_unavailable',
        },
      });
      return null;
    }
    // Preserve the caller's exact id. Trimming or name-based recovery would be
    // a different identity and is deliberately not attempted.
    requestedAgentId = body.agentId;
  }

  /**
   * The skills the person picked for this message, by name.
   *
   * The same three-state shape the connector selector uses: omitted lets the
   * model discover from the index, `null` withholds skills entirely, and an
   * array names the ones to inline. Whether a name is REACHABLE is not decided
   * here — `buildSkillRuntime` resolves every name against what this account
   * actually installed, so an unknown one is ignored rather than 400ing a chat
   * over a stale composer selection.
   */
  let selectedSkillNames: string[] | null | undefined;
  if (body.skillIds === undefined || body.skillIds === null) {
    selectedSkillNames = body.skillIds as null | undefined;
  } else if (!Array.isArray(body.skillIds) || body.skillIds.some((name: unknown) => typeof name !== 'string')) {
    res.status(400).json({
      error: {
        message: 'skillIds must be an array of skill names, or null.',
        type: 'invalid_request_error',
        param: 'skillIds',
        code: 'invalid_skill_ids',
      },
    });
    return null;
  } else {
    selectedSkillNames = (body.skillIds as string[]).map((name) => name.trim()).filter((name) => name !== '');
  }

  let mcpServerId: string | null | undefined;
  if (body.mcpServerId === undefined || body.mcpServerId === null) {
    mcpServerId = body.mcpServerId;
  } else if (typeof body.mcpServerId !== 'string' || body.mcpServerId.trim() === '') {
    res.status(400).json({
      error: {
        message: 'mcpServerId must be a connector id or null.',
        type: 'invalid_request_error',
        param: 'mcpServerId',
        code: 'invalid_mcp_server_id',
      },
    });
    return null;
  } else if (!isDirectUserSession || !req.user?.id) {
    res.status(400).json({
      error: {
        message: 'The selected connector is unavailable.',
        type: 'invalid_request_error',
        param: 'mcpServerId',
        code: 'mcp_server_unavailable',
      },
    });
    return null;
  } else {
    const selectedServer = await findMcpServerForUser(getDb(), body.mcpServerId, req.user.id);
    const runnable = selectedServer?.enabled === true &&
      selectedServer.status === 'running' &&
      selectedServer.runtime === 'server';
    if (!runnable) {
      res.status(400).json({
        error: {
          message: 'The selected connector is unavailable.',
          type: 'invalid_request_error',
          param: 'mcpServerId',
          code: 'mcp_server_unavailable',
        },
      });
      return null;
    }
    mcpServerId = selectedServer.id;
  }
  /**
   * What this request routes on, resolved at the boundary and once.
   *
   * Three shapes reach here and all three come out as an ALIAS, because the
   * alias is what carries the metadata the rest of this path needs — the credit
   * multiplier `credits-manager.ts` bills on, the entitlement id
   * `plan-access.ts` checks, the tier the fallback engine walks, and the system
   * prompt the id selects. Translating once, here, is what keeps every one of
   * those from learning a second vocabulary:
   *
   *  - **`profile:*`**, the policy vocabulary `GET /catalogue` publishes,
   *    becomes the alias that serves that policy.
   *  - **`<publisher>/<model>`**, the model vocabulary it now also publishes,
   *    becomes the alias of the profile the model is SERVED UNDER, plus the
   *    identity — which travels separately, on the routing options, because it
   *    answers a different question: not which tier, but which of that tier's
   *    models may answer.
   *  - **a legacy `alia-*` identifier** passes through untouched and keeps
   *    working, which is what nothing-advertises-them means in practice: every
   *    installed `@alia.onl/sdk` and `@alia-codea/cli` copy still resolves.
   *
   * Both refusals happen HERE rather than downstream, because the resolver's
   * own refusal talks about the alias list and that is the wrong list for a
   * caller who named either a profile or a model.
   */
  /**
   * A model served by the caller's OWN machine short-circuits the resolver.
   *
   * `local/<runtimeId>/<model>` names no Alia route, holds no credential and
   * belongs to no tier, so every question the resolver answers — which key,
   * which deployment, which fallback order — is the wrong question for it. It
   * is also why the gates below are skipped rather than passed: there is no
   * plan that grants someone their own hardware, and nothing to bill for using
   * it. See `lib/inference/user-runtime-bridge.ts`.
   */
  const localRuntime: UserRuntimeSelection | null = parseUserRuntimeModel(body.model);
  /**
   * The resolution a local turn uses in place of `resolveModel`.
   *
   * Built inside the gate below rather than in the prefetch, because that is
   * where the owner's id is known to exist: `userRuntimeCanServe` cannot answer
   * true without one, so the narrowing here is the same fact the gate already
   * established rather than an assertion on top of it.
   */
  let localResolved: ChatRequestContext['resolved'] = null;
  if (localRuntime !== null) {
    /**
     * Checked BEFORE the stream opens. A tab that has since been closed is the
     * ordinary case, not an exceptional one, and answering it with a refusal
     * the picker can act on beats a turn that dies after the headers are out.
     *
     * An unauthenticated caller is refused by the same condition, and that
     * matters more than it looks: this is the one turn that reserves no
     * credits, so "no user" must never mean "no billing".
     */
    const owner = req.user?.id;
    if (owner === undefined || !(await userRuntimeCanServe(owner, localRuntime))) {
      clearTimeout(globalTimer);
      const refusal = {
        message: redactUnsafeDetail(
          `"${String(body.model)}" is served by your own device, and no device offering it is connected. ` +
            'Open Alia where that model runs, then try again.',
        ),
        type: 'invalid_request_error',
        param: 'model',
        code: 'local_runtime_unavailable',
      };
      if (sse.sent) {
        sse.writeError(refusal);
      } else {
        res.status(409).json({ error: refusal });
      }
      return null;
    }

    localResolved = {
      routingProfileId: String(body.model),
      provider: USER_RUNTIME_PROVIDER,
      /**
       * Who released the model is genuinely unknown: the person typed a tag
       * their own server recognises, and Alia has no table mapping it to a
       * publisher. Unknown is recorded as unknown — a guess would be a
       * provenance claim nothing measured.
       */
      publisher: 'unknown',
      model: localRuntime.model,
      modelId: localRuntime.model,
      /**
       * Kaana does not serve this and never can: the deployment is a process on
       * the caller's own machine, reachable from one place that is not a
       * datacentre. `null` is the honest answer rather than an omission, and it
       * is what keeps `getAIModel` out of the Kaana branch entirely.
       */
      oxyInferenceTarget: null,
      keyConfig: {
        provider: USER_RUNTIME_PROVIDER,
        modelId: localRuntime.model,
        userRuntime: { userId: owner, runtimeId: localRuntime.runtimeId },
      },
      routingProfile: {
        id: String(body.model),
        name: localRuntime.model,
        tier: 'local',
        description: 'Served by the user\u2019s own device.',
        creditMultiplier: 0,
        maxTokens: 0,
        supportsTools: true,
        supportsVision: false,
        category: 'local',
      },
      isFallback: false,
    };
  }

  /**
   * A local turn may not escalate into inference Alia pays for.
   *
   * This is the whole safety argument for reserving no credits. The saving is
   * real only while the turn stays on the person's own hardware, and two
   * request flags take it straight back off:
   *
   *  - **`deepResearch`** runs `lib/research/research-engine.ts`, which resolves
   *    `kaana-lite` and `kaana-v1` BY NAME (lines 221, 269, 300, 335) and calls
   *    them several times per turn. `lib/chat-modes/deep-research-handler.ts`
   *    finalizes credits under `if (creditReservation)`, so with no reservation
   *    that work is charged to nobody.
   *  - **`agentMode`** adds `delegateToAgent`, and `lib/tools/agent-delegate.ts`
   *    resolves a hosted model the same way (line 70).
   *
   * Refused rather than silently downgraded: a person who asked for deep
   * research and got an ordinary answer has been told something untrue about
   * the turn they paid nothing for. The composer hides both controls for a local
   * model; this is what answers a client that asks anyway.
   *
   * The `deepResearch` TOOL is withheld separately, in `lib/tool-pipeline.ts` —
   * the model can reach the same engine by calling it, and a flag check here
   * would not see that.
   */
  if (localRuntime !== null && (deepResearch === true || agentMode)) {
    clearTimeout(globalTimer);
    const refusal = {
      message:
        'Deep research and agent mode run on Alia\u2019s own models, so they are not available for a model running on your device. Pick a Kaana routing profile to use them.',
      type: 'invalid_request_error',
      param: deepResearch === true ? 'deepResearch' : 'agentMode',
      code: 'local_runtime_capability_unavailable',
    };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(400).json({ error: refusal });
    }
    return null;
  }

  const requested: RequestedModel =
    localRuntime === null
      ? await resolveRequestedModel(body.model || getDefaultRoutingProfile())
      : { kind: 'routing-profile', routingProfile: String(body.model) };
  if (requested.kind === 'unknown-profile' || requested.kind === 'unknown-model') {
    /**
     * Two refusals, because they are two different mistakes.
     *
     * A `profile:` nobody defines is a policy that does not exist. A
     * `<publisher>/<model>` the catalogue does not offer may well be a model
     * that EXISTS — it is simply not one a person may pin on its own, because
     * its price sits outside the band its profile is sold at
     * (`lib/routing/model-selection.ts`) — and telling that caller to go and
     * look at the profile list would be the wrong list.
     */
    const refusal =
      requested.kind === 'unknown-profile'
        ? {
            message: redactUnsafeDetail(
              `"${requested.requested}" is not a routing profile. List them at GET /catalogue.`,
            ),
            type: 'invalid_request_error',
            param: 'model',
            code: 'unknown_routing_profile',
          }
        : {
            message: redactUnsafeDetail(
              `"${requested.requested}" is not a model you can select on its own. ` +
                'List what you can at GET /catalogue.',
            ),
            type: 'invalid_request_error',
            param: 'model',
            code: 'unknown_model',
          };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(400).json({ error: refusal });
    }
    return null;
  }
  const requestedModel = requested.routingProfile;
  /**
   * The effort level, resolved here and nowhere else.
   *
   * It needs `requestedModel` because one of the three spellings IS a model
   * identifier (`kaana-v1-thinking`), which is why it sits below the resolution
   * rather than beside the other body fields.
   */
  const reasoningEffort = reasoningEffortOf({
    reasoningEffort: body.reasoningEffort,
    thinkingMode: body.thinkingMode as boolean | undefined,
    requestedModel,
  });
  /**
   * A named model narrows the candidate set to that model's deployments.
   *
   * It rides on the same options object the fallback policy does, so the
   * provider loop's RE-resolve inherits it for free — a retry that quietly
   * widened back to the profile would answer from a different model one attempt
   * later, which is the substitution ADR 0003 invariant 2 forbids.
   */
  const routingOptions: RoutingOptions = {
    ...(requestedPolicy === undefined ? {} : { fallbackPolicy: requestedPolicy }),
    ...(requested.kind === 'model' ? { pinnedModel: requested.identity } : {}),
  };

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

  const [creditResult, resolvedResult, userMemory, oxyUser, entitlements, turnAgent] = await Promise.all([
    // Credits: sequential pair (getOrCreate → reserve), parallel with everything else
    // Skip for internal service requests (no credits charged)
    /**
     * A local turn reserves nothing. It is not a discount — no inference of
     * Alia's is spent — and the skip has to be here rather than a refund later:
     * any exit that neither charges nor refunds silently costs the person the
     * reserved credit.
     */
    (req.user && !req.serviceApp && localRuntime === null) ? (async () => {
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
    localResolved !== null
      ? Promise.resolve(localResolved)
      : resolveModel(requestedModel, undefined, undefined, routingOptions).catch((err: unknown) => {
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

    // User entitlements (plan-based model access) — parallelized to avoid sequential delay
    (req.user && !req.apiKey)
      ? getUserEntitlements(req.user.id).catch(() => null)
      : Promise.resolve(null),

    /**
     * The agent this TURN is for, named by the request rather than inferred.
     *
     * `body.agentId` is what the client has been sending all along and nothing
     * read; the thread-id lookup that stood here could not match and never once
     * resolved an agent. {@link loadTurnAgent} owns the authorisation — see its
     * docblock for why a published agent needs none and a draft needs
     * `account:act_as`.
     *
     * Resolved ONCE, here, and read from the context by everything downstream:
     * the system prompt, the tool set and the escalation branch all name the
     * same agent, and three lookups of one id are three chances to disagree.
     */
    (requestedAgentId !== undefined && req.user)
      ? loadTurnAgent(getDb(), {
          agentId: requestedAgentId,
          oxyUserId: req.user.id,
          accessToken: req.accessToken,
          applicationId: req.serviceApp?.appId,
        }).catch((err: unknown) => {
          /**
           * A repository failure is not permission to substitute another
           * identity. It is surfaced through the same retryable refusal as an
           * unavailable identity lookup; the important invariant here is that
           * an explicit selector can never become `kind: 'none'`.
           */
          log.v1.warn({ err, agentId: requestedAgentId }, 'Could not resolve the turn agent');
          return { kind: 'resolution_unavailable' } as const;
        })
      : Promise.resolve({ kind: 'none' } as const),
  ]);

  log.v1.info({ durationMs: Date.now() - preStreamStart }, 'Pre-stream setup complete');

  // Validate credit reservation
  // Only return 402 if reserveCredits explicitly returned null (insufficient credits),
  // not if there was a DB error (original behavior: continue without credits on error)
  const creditReservation = creditResult.reservation;
  /**
   * A local turn arrives here with no reservation and no error, which is
   * exactly the shape this branch reads as "out of credits" — so the skip has
   * to be repeated here and not only where the reservation is taken. Missed,
   * every local turn 402s before reaching a model, and the person is told to
   * buy credits for running a model on their own hardware.
   */
  if (req.user && !req.serviceApp && !creditReservation && !creditResult.error && localRuntime === null) {
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
   * A turn that named an agent we could not verify is REFUSED, never answered
   * by somebody else.
   *
   * This is the second, independent cause of the symptom `#453` fixed: the
   * client goes on rendering the agent's name and colour around the reply, so
   * substituting Alia tells the person they are talking to Claudio while Alia
   * answers. An identity failure cannot resolve to "you are someone else"; it
   * either fails or says so out loud, and this is the surface with nowhere to
   * say it.
   *
   * 502 because nothing about the request is wrong and retrying may work, and
   * it is `refusalStatus`/`refusalMessage`'s own answer for this refusal rather
   * than a second opinion about it. The reservation is refunded, matching every
   * other branch here that rejects a request after credits were held — an exit
   * that neither charges nor refunds silently costs the person a credit.
   */
  if (turnAgent.kind === 'identity_unavailable') {
    if (creditReservation) await refundReservation(creditReservation);
    clearTimeout(globalTimer);
    const refusal = {
      message: refusalMessage('identity_unavailable'),
      type: 'server_error',
      param: 'agentId',
      code: 'IDENTITY_UNAVAILABLE',
    };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(refusalStatus('identity_unavailable')).json({ error: refusal });
    }
    return null;
  }

  if (turnAgent.kind === 'resolution_unavailable') {
    if (creditReservation) await refundReservation(creditReservation);
    clearTimeout(globalTimer);
    const refusal = {
      message: 'The selected agent could not be resolved. Please try again.',
      type: 'server_error',
      param: 'agentId',
      code: 'AGENT_RESOLUTION_UNAVAILABLE',
    };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(503).json({ error: refusal });
    }
    return null;
  }

  /**
   * Missing and unauthorised are deliberately the same public refusal. The
   * typed internal reason remains useful for tests and telemetry, but exposing
   * it would let a caller probe private agent ids. Most importantly, neither
   * outcome falls through to `linkedAgent = null`, which is ordinary Alia.
   */
  if (turnAgent.kind === 'unavailable') {
    if (creditReservation) await refundReservation(creditReservation);
    clearTimeout(globalTimer);
    const refusal = {
      message: 'The selected agent is unavailable.',
      type: 'invalid_request_error',
      param: 'agentId',
      code: 'agent_unavailable',
    };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(404).json({ error: refusal });
    }
    return null;
  }

  const linkedAgent = turnAgent.kind === 'agent' ? turnAgent.agent : null;

  /**
   * Product-agent inference is charged to the product application that entered
   * this request. The same already-verified service token is forwarded to Oxy;
   * Oxy therefore derives payer, application and credential from its claims.
   * The delegated user remains attribution only. No request body field and no
   * agent row can choose the payer.
   */
  let inferenceServiceToken: string | undefined;
  if (linkedAgent?.applicationId != null) {
    const exactApplication = req.serviceApp?.appId === linkedAgent.applicationId;
    const exactDelegation =
      req.user?.id !== undefined &&
      req.serviceActingAs?.userId === req.user.id;
    const hasInferenceScope =
      req.serviceApp?.scopes.includes('inference:invoke') === true &&
      req.serviceActingAs?.scopes.includes('inference:invoke') === true;
    if (!exactApplication || !exactDelegation || !hasInferenceScope || !req.accessToken) {
      clearTimeout(globalTimer);
      const refusal = {
        message: 'The selected agent is unavailable.',
        type: 'invalid_request_error',
        param: 'agentId',
        code: 'agent_unavailable',
      };
      if (sse.sent) {
        sse.writeError(refusal);
      } else {
        res.status(404).json({ error: refusal });
      }
      return null;
    }
    inferenceServiceToken = req.accessToken;
  }

  /**
   * Skills, after the batch rather than inside it: the candidate set includes
   * the skills linked to whichever agent this conversation runs, and that agent
   * is one of the things the batch resolves.
   *
   * Available to API-key callers too, unlike the prompt fragment this replaces.
   * Authorization is now an install owned by `req.user.id`, and a developer key
   * carries its owner's account — so scoping it to interactive sessions would
   * withhold a person's own skills from their own API key for no reason.
   */
  const skills = req.user?.id
    ? await buildSkillRuntime({
        db: getDb(),
        oxyUserId: req.user.id,
        conversationId,
        selectedNames: selectedSkillNames,
        agentSkillIds: linkedAgent ? (await findAgentSkills(getDb(), linkedAgent.id)).map((ref) => ref._id) : [],
        // Linking a skill to an agent is the explicit grant. A person's other
        // installed skills are not inherited by every agent they talk to.
        includeUserInstalled: linkedAgent === null,
      }).catch((err) => {
        log.v1.warn({ err }, 'Skill runtime unavailable for this turn');
        return null;
      })
    : null;

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

  const routingProfileId = resolved.routingProfileId;
  log.v1.info({ provider: resolved.provider, modelId: resolved.modelId }, 'Using provider');

  // Enforce plan-based model access (skip for API-key requests)
  // Uses entitlements prefetched in Promise.all above
  // No plan grants a person their own hardware, so there is nothing to check.
  if (req.user && !req.apiKey && entitlements && localRuntime === null) {
    if (!entitlements.allowedModelIds.includes(routingProfileId)) {
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
      model: routingProfileId,
      skillNames: selectedSkillNames ?? undefined,
      platform: req.apiKey ? 'telegram' as const : 'app' as const,
      metadata: {},
    }).catch(() => null);
    recalledMemories = hookResult?.metadata?.recalledMemories as Array<{ title: string; summary: string }> | undefined;
  }

  return {
    body,
    messages,
    conversationId,
    reasoningEffort,
    agentMode,
    deepResearch,
    webSearch,
    mcpServerId,
    includeUsage,
    isDirectUserSession,
    requestedModel,
    promptModelId: localRuntime === null ? routingProfileId : getDefaultRoutingProfile(),
    isLocalRuntime: localRuntime !== null,
    clientContext,
    userMemory,
    oxyUser,
    skills: skills ?? { index: '', active: '', tools: {}, agentScoped: false, candidateIds: [], activated: () => [] },
    entitlements,
    linkedAgent,
    inferenceServiceToken,
    creditReservation,
    resolved,
    routingProfileId,
    routingOptions,
    autonomyRuntime,
    recalledMemories,
  };
}
