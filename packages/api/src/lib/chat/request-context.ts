import { randomUUID } from 'node:crypto';
import { parseHostRequest, type HostRequest } from '../host-tools.js';
import { productCreditPlanId } from '../product-credit-contract';
import { USAGE_WINDOW_CREDITS } from '../usage-window';
import { readConfiguredProductCreditSnapshot } from '../product-credit-access';
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
import { captureCreditPriceBook } from '../credit-price-snapshot.js';
import { admitMachineTurn } from './machine-turn.js';
import { MAX_TOOLS_PER_INFERENCE_REQUEST } from '../inference/tool-limit.js';
import type { Request, Response } from 'express';
import { resolveModel, resolveDefaultModel, type ResolvedModel } from '../chat-core.js';
import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from '../models/catalogue.js';
import { ModelNotFoundError } from '../models/errors.js';
import {
  USER_RUNTIME_PROVIDER,
  parseUserRuntimeModel,
  userRuntimeCanServe,
  type UserRuntimeSelection,
} from '../inference/user-runtime-bridge.js';
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
import type { UserMemoryProfile } from '../../db/memory/userMemoryRepository.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import { reserveCredits, refundReservation, type CreditReservation } from '../credits-manager.js';
import { getUserEntitlements, type Entitlements } from '../plan-access.js';
import {
  buildTurnSkills,
  EMPTY_SKILL_RUNTIME,
  prefetchTurnInputs,
  recallTurnMemories,
} from './turn-inputs.js';
import { readUsageWindow, secondsUntilReset, type UsageWindow } from '../usage-window.js';
import {
  PROMPT_SURFACES,
  type OxyUserProfile,
  type PromptSurface,
} from '../system-prompt-builder.js';
import type { SkillRuntime } from '../skills/runtime.js';
import { log } from '../logger.js';
import { refusalMessage, refusalStatus } from '../agent-account.js';
import type { HydratedAgent } from '../agent-identity.js';
import { findMcpServerForUser } from '../../db/integrations/mcpServerRepository.js';
import { runAutonomyBeforeChat, type AutonomyRuntimeContext } from '../autonomy/runtime.js';
import type { ChatMessage, FilePartRef } from '../message-converter.js';
import {
  FilePartError,
  filePartsOf,
  resolveFileParts,
  type ResolvedFiles,
} from '../files/person-files.js';
import {
  attachedPartsOf,
  checkGatedParts,
  gatedPartsFor,
  spendGatedParts,
  type FeatureRefusal,
  type GatedPart,
} from '../agent-features.js';
import type { TurnAgentResolution } from './turn-inputs.js';
import { usableMessageId } from '../../domain/conversation.js';
import type { OpenAITool } from '../tool-converter.js';
import type { SSEWriter } from './sse-writer.js';

/**
 * Which product surface a turn comes from (`body.surface`). It selects the
 * system prompt, never the model (ADR 0012).
 */

function promptSurfaceOf(value: unknown): PromptSurface | null {
  if (value === undefined || value === null) return 'chat';
  return typeof value === 'string' && (PROMPT_SURFACES as readonly string[]).includes(value)
    ? (value as PromptSurface)
    : null;
}

export interface ChatRequestContext {
  body: Record<string, unknown> & {
    model?: string;
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
   * The id the client drew this turn's reply under, which the reply is stored
   * with — so a vote or a read-aloud on the reply it is still showing finds
   * the row (`lib/conversation-saver.ts`). `undefined` when not sent.
   */
  assistantMessageId: string | undefined;
  /**
   * How hard this request was asked to think, or `null` for the model's default.
   * Validated at the boundary against the model's catalogue `reasoningEfforts`
   * and forwarded to Oxy as `reasoning: { effort }`.
   */
  reasoningEffort: ReasoningEffort | null;
  /**
   * `'voice'` when the caller says the answer will be spoken (a voice call's
   * turn), else `null`. Only the prompt reads it; routing, tools and billing
   * are the same as for a typed turn.
   */
  responseMode: 'voice' | null;
  /** The embedding app's UI effects and the outcomes of earlier ones (`lib/host-tools.ts`). */
  host: HostRequest | undefined;
  /**
   * What the model reads for each `file` part, by Oxy Files id: read as the
   * person before the turn was admitted (`lib/files/person-files.ts`). The
   * messages themselves keep the reference, which is what is stored.
   */
  files: ResolvedFiles;
  deepResearch: boolean | undefined;
  /**
   * Whether Alia may reach the open web for this turn.
   *
   * `true` when the caller said nothing, which is the behaviour every request
   * has had: `lib/tool-pipeline.ts` put `webSearch`, `webScraper` and (then) `browse`
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
  /** What the caller asked for (`body.model`), or the default it resolved to. */
  requestedModel: string;
  /** The surface whose prompt the turn speaks with (`body.surface`). */
  surface: PromptSurface;
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
   * The verified inbound caller bearer: an application-bound agent service
   * token or an app-only machine credential. Undefined means the ordinary
   * Alia credential lane. This is selected only
   * after exact application and delegation checks, so `agentId` never chooses
   * the billing principal.
   */
  inferenceServiceToken: string | undefined;
  /** Initial values for the handler's retry-mutable state. */
  creditReservation: CreditReservation | null;
  resolved: ResolvedModel;
  /** The model this turn runs on: `publisher/model`, or the local runtime id. */
  modelId: string;
  autonomyRuntime: AutonomyRuntimeContext | null;
  recalledMemories: Array<{ title: string; summary: string }> | undefined;
}

export async function buildChatRequestContext(
  req: Request,
  res: Response,
  sse: SSEWriter,
  globalTimer: NodeJS.Timeout,
  aliaRequestId?: string,
): Promise<ChatRequestContext | null> {
  const body = req.body;
  const machineTurn = admitMachineTurn(req);
  if (machineTurn && 'error' in machineTurn) {
    res.status(403).json({
      error: {
        code: machineTurn.error,
        message: 'This machine credential authorizes an app-only chat turn.',
      },
    });
    return null;
  }

  // Validate request body
  if (!body || typeof body !== 'object') {
    res.status(400).json({
      error: {
        message: 'Request body must be a JSON object.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_request_body',
      },
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
      },
    });
    return null;
  }

  /**
   * `fallbackPolicy` is REFUSED, not honoured and not ignored.
   *
   * It used to be validated here and handed to `resolveModel`, which ignored
   * it — a silent no-op behind an accepted parameter. Since #477 fallback is
   * not Alia's to decide: the public Oxy inference request
   * (`OxyResponsesRequest` in `@oxy.so/core`) carries no fallback, substitution
   * or route field at all, and the contract's `authorizedRoutes` is Oxy's own
   * envelope to Kaana — "the result of applying the policy" the application's
   * routing policy resolves server-side (ADR 0017), never a value a caller
   * sets. So a caller sending one is asking for something this API cannot
   * carry, and the honest answer is 400 rather than a request that quietly
   * did something else. Both spellings, because `GET /catalogue` documents
   * the wire name as `fallback_policy`.
   *
   * Refused here, before any credits are reserved, like `messages`.
   */
  const sentFallbackPolicy =
    body.fallbackPolicy !== undefined
      ? 'fallbackPolicy'
      : body.fallback_policy !== undefined
        ? 'fallback_policy'
        : null;
  if (sentFallbackPolicy !== null) {
    const refusal = {
      message:
        `"${sentFallbackPolicy}" is not a request parameter. Fallback between deployments of ` +
        'the model you select is decided by Oxy.',
      type: 'invalid_request_error',
      param: sentFallbackPolicy,
      code: 'invalid_request',
    };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(400).json({ error: refusal });
    }
    return null;
  }

  /**
   * A malformed `assistantMessageId` is refused, not dropped: dropping it
   * stores the reply under a name the client does not hold, which is the
   * silent 404 on every vote and read-aloud this field exists to end.
   */
  const assistantMessageId = usableMessageId(body.assistantMessageId);
  if (body.assistantMessageId !== undefined && assistantMessageId === undefined) {
    const refusal = {
      message: '"assistantMessageId" must be a non-empty string of at most 128 characters.',
      type: 'invalid_request_error',
      param: 'assistantMessageId',
      code: 'invalid_request',
    };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(400).json({ error: refusal });
    }
    return null;
  }

  /**
   * More client tools than one inference request can carry at all.
   *
   * A client's own tools are always sent — it executes them itself, so none can
   * be deferred — and the Oxy edge refuses a request with more than
   * {@link MAX_TOOLS_PER_INFERENCE_REQUEST}. Refused here, before credits are
   * reserved; `ToolPipeline.forUser` makes the exact check once Alia's own
   * tools are counted beside them.
   */
  if (Array.isArray(body.tools) && body.tools.length > MAX_TOOLS_PER_INFERENCE_REQUEST) {
    const refusal = {
      message:
        `"tools" has ${body.tools.length} entries; one request may carry at most ` +
        `${MAX_TOOLS_PER_INFERENCE_REQUEST} tools, Alia's own included.`,
      type: 'invalid_request_error',
      param: 'tools',
      code: 'invalid_request',
    };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(400).json({ error: refusal });
    }
    return null;
  }

  // Extract optional parameters for Alia internal features
  const conversationId = body.conversationId as string | undefined;
  const parsedHost = parseHostRequest(body.host);
  if (!parsedHost.ok) {
    clearTimeout(globalTimer);
    res.status(400).json({
      error: {
        message: parsedHost.message,
        type: 'invalid_request_error',
        param: 'host',
        code: 'invalid_host',
      },
    });
    return null;
  }
  const host = parsedHost.host;

  /**
   * The `file` parts, by id, refused here when malformed: before the stream
   * opens and before anything is read, spent or reserved.
   */
  let fileRefs: Map<string, FilePartRef>;
  try {
    fileRefs = filePartsOf(messages);
  } catch (error: unknown) {
    if (!(error instanceof FilePartError)) throw error;
    clearTimeout(globalTimer);
    res.status(400).json({
      error: {
        message: error.message,
        type: 'invalid_request_error',
        param: 'messages',
        code: error.code,
      },
    });
    return null;
  }
  // Deep research is a request flag, never implied by the model (ADR 0012).
  const deepResearch = body.deepResearch as boolean | undefined;
  // Absent means ON, which is what every request did before the switch existed.
  const webSearch = machineTurn === null && body.webSearch !== false;
  const streamOptions = body.stream_options as { include_usage?: boolean } | undefined;
  const includeUsage = streamOptions?.include_usage === true;

  log.v1.info(
    {
      messageCount: messages.length,
      conversationId,
      deepResearch,
      webSearch,
    },
    'Processing messages',
  );

  let autonomyRuntime: AutonomyRuntimeContext | null = null;
  if (req.user?.id) {
    autonomyRuntime = await runAutonomyBeforeChat({
      userId: req.user.id,
      messages,
    }).catch(() => null);
  }

  // Determine if this is a direct user session.
  // A delegated service request has a person in `req.user`, but its principal
  // is still the verified application in `req.serviceApp`. Calling it a direct
  // session would erase the application boundary and expose direct-only
  // context/tools to a machine caller.
  const isDirectUserSession = !!req.user && !req.serviceApp;
  /**
   * A present requester (ADR 0025 in OxyHQServices): a person signed in to a
   * first-party product that entered with a requester assertion Oxy consumed
   * live. It admits exactly the one native agent the assertion names, checked
   * below and again when the agent's application binding is read.
   */
  const isPresentRequesterSession =
    !!req.user?.id &&
    !!req.serviceApp &&
    req.oxyRequester?.userId === req.user.id &&
    req.oxyRequester.applicationId === req.serviceApp.appId &&
    req.oxyRequester.credentialId === req.serviceApp.credentialId;
  const isDelegatedServiceSession =
    !!req.user?.id &&
    !!req.serviceApp &&
    (req.serviceActingAs?.userId === req.user.id || isPresentRequesterSession);

  /**
   * An assertion is for ONE agent. Without this, a verified requester could
   * omit `agentId` (ordinary Alia, with the person's memory) or name a public
   * agent, and use a product's entry to reach what that product never asked for.
   * Same neutral refusal as every other unavailable agent.
   */
  if (
    req.oxyRequester !== undefined &&
    (!isPresentRequesterSession || body.agentId !== req.oxyRequester.agentId)
  ) {
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
      typeof body.agentId !== 'string' ||
      body.agentId === '' ||
      body.agentId.trim() !== body.agentId
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
  } else if (
    !Array.isArray(body.skillIds) ||
    body.skillIds.some((name: unknown) => typeof name !== 'string')
  ) {
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
    selectedSkillNames = (body.skillIds as string[])
      .map((name) => name.trim())
      .filter((name) => name !== '');
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
    const runnable =
      selectedServer?.enabled === true &&
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
   * What this request runs on, resolved at the boundary and once (ADR 0012):
   *
   *  - **a power level** — `auto`, `instant`, `medium`, `high`, `xhigh`, `pro`
   *    or `ultra` (ADR 0014): Oxy picks the model of that level per request.
   *    What Alia's own app sends.
   *  - **`publisher/model`** — a model from Oxy's catalogue, as `GET /catalogue`
   *    lists it. Anything the catalogue does not offer for chat is a 400
   *    `model_not_found`.
   *  - **absent** — the `auto` power level.
   *  - **`local/<runtime>/<model>`** — the caller's own machine, below.
   */
  if (
    body.model !== undefined &&
    body.model !== null &&
    (typeof body.model !== 'string' || body.model.trim() === '')
  ) {
    clearTimeout(globalTimer);
    res.status(400).json({
      error: {
        message:
          'model must be a power level (auto, instant, medium, high, xhigh, pro, ultra), a model id from GET /catalogue, or omitted for auto.',
        type: 'invalid_request_error',
        param: 'model',
        code: 'invalid_model',
      },
    });
    return null;
  }
  const surface = promptSurfaceOf(body.surface);
  if (surface === null) {
    clearTimeout(globalTimer);
    res.status(400).json({
      error: {
        message: `surface must be one of: ${PROMPT_SURFACES.join(', ')}.`,
        type: 'invalid_request_error',
        param: 'surface',
        code: 'invalid_surface',
      },
    });
    return null;
  }
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
  let localResolved: ResolvedModel | null = null;
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
      catalogue: null,
      powerLevel: null,
    };
  }

  /**
   * A local turn may not escalate into inference Alia pays for.
   *
   * This is the whole safety argument for reserving no credits. The saving is
   * real only while the turn stays on the person's own hardware, and one
   * request flag takes it straight back off:
   *
   *  - **`deepResearch`** runs `lib/research/research-engine.ts`, which resolves
   *    hosted catalogue models and calls them several times per turn. `lib/chat-modes/deep-research-handler.ts`
   *    finalizes credits under `if (creditReservation)`, so with no reservation
   *    that work is charged to nobody.
   *
   * Refused rather than silently downgraded: a person who asked for deep
   * research and got an ordinary answer has been told something untrue about
   * the turn they paid nothing for. The composer hides the control for a local
   * model; this is what answers a client that asks anyway. `consultAgent`, the
   * other way into hosted inference, is withheld by `lib/tool-pipeline.ts`.
   *
   * The `deepResearch` TOOL is withheld separately, in `lib/tool-pipeline.ts` —
   * the model can reach the same engine by calling it, and a flag check here
   * would not see that.
   */
  if (localRuntime !== null && deepResearch === true) {
    clearTimeout(globalTimer);
    const refusal = {
      message:
        'Deep research runs on hosted models, so it is not available for a model running on your device. Pick a model from the catalogue to use it.',
      type: 'invalid_request_error',
      param: 'deepResearch',
      code: 'local_runtime_capability_unavailable',
    };
    if (sse.sent) {
      sse.writeError(refusal);
    } else {
      res.status(400).json({ error: refusal });
    }
    return null;
  }

  /**
   * The hosted model, resolved BEFORE any credit is reserved or the stream is
   * opened, so an unknown model is a plain 400 rather than a refund. The
   * catalogue read is cached (`lib/models/catalogue.ts`).
   */
  let resolved: ResolvedModel;
  if (localResolved !== null) {
    resolved = localResolved;
  } else {
    try {
      resolved =
        typeof body.model === 'string' ? await resolveModel(body.model) : resolveDefaultModel();
    } catch (err: unknown) {
      clearTimeout(globalTimer);
      const refusal =
        err instanceof ModelNotFoundError
          ? {
              message: err.userMessage,
              type: 'invalid_request_error',
              param: 'model',
              code: ModelNotFoundError.WIRE_CODE,
            }
          : {
              message: 'No models available. Please try again.',
              type: 'server_error',
              param: 'model',
              code: 'model_not_available',
            };
      if (!(err instanceof ModelNotFoundError)) log.v1.error({ err }, 'Error resolving model');
      if (sse.sent) {
        sse.writeError(refusal);
      } else {
        res.status(err instanceof ModelNotFoundError ? 400 : 503).json({ error: refusal });
      }
      return null;
    }
  }
  // A local turn is named by the full `local/<runtime>/<model>` the person
  // picked; `resolved.modelId` is only the runtime's own tag.
  const modelId = localRuntime === null ? resolved.modelId : String(body.model);
  const requestedModel = typeof body.model === 'string' ? body.model : modelId;

  /**
   * The effort level: `low` | `medium` | `high`, and only one the model
   * declares in its catalogue `reasoningEfforts`. A local model takes none.
   * A power level sets its own effort; a caller's explicit one wins and Oxy
   * keeps only the level's models that accept it.
   */
  let reasoningEffort: ReasoningEffort | null = null;
  if (body.reasoningEffort !== undefined && body.reasoningEffort !== null) {
    const offered: readonly ReasoningEffort[] =
      resolved.powerLevel !== null
        ? REASONING_EFFORTS
        : (resolved.catalogue?.reasoningEfforts ?? []);
    if (!isReasoningEffort(body.reasoningEffort) || !offered.includes(body.reasoningEffort)) {
      clearTimeout(globalTimer);
      const refusal = {
        message: redactUnsafeDetail(
          offered.length === 0
            ? `"${modelId}" does not take a reasoning effort.`
            : `reasoningEffort must be one of: ${offered.join(', ')} for "${modelId}".`,
        ),
        type: 'invalid_request_error',
        param: 'reasoningEffort',
        code: 'invalid_reasoning_effort',
      };
      if (sse.sent) {
        sse.writeError(refusal);
      } else {
        res.status(400).json({ error: refusal });
      }
      return null;
    }
    reasoningEffort = body.reasoningEffort;
  }

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

  const creditAccountId = req.user?.id;
  /**
   * The person's memory, profile, entitlements and the turn's agent are the
   * turn's INPUTS, read from an identity by `lib/chat/turn-inputs.ts` — the
   * same reads a voice call makes (ADR 0017 §3). The agent is the one this
   * TURN is for, named by the request rather than inferred; `loadTurnAgent`
   * owns the authorisation and an unresolvable selector is never `none`.
   */
  const turnInputs = prefetchTurnInputs({
    oxyUserId: req.user?.id,
    accessToken: req.accessToken,
    isDirectUserSession,
    requestedAgentId,
    applicationId: req.serviceApp?.appId,
  });

  /**
   * The turn's attachments are ADMITTED before any credit is reserved
   * (ADR 0020 §6): the agent's feature gates are checked, every document is
   * read as the person, and only then is each gated part spent. A refusal at
   * any step reserves nothing. A turn with no attachment skips all of it and
   * reserves in parallel with the reads, as before.
   */
  const turnRequestId = aliaRequestId ?? randomUUID();
  const attachedParts = attachedPartsOf(messages, turnRequestId);
  const admission: Promise<AttachmentAdmission> =
    attachedParts.length === 0
      ? Promise.resolve({ ok: true, files: new Map() })
      : admitAttachments({
          turnAgent: requestedAgentId === undefined ? null : turnInputs.then((i) => i.turnAgent),
          parts: attachedParts,
          fileRefs,
          person: {
            accountId: req.user?.id,
            // The person's own bearer only: a service token is not them.
            accessToken: isDirectUserSession ? req.accessToken : undefined,
            runId: turnRequestId,
          },
          modelAcceptsFiles: resolved.catalogue?.inputModalities.includes('file') === true,
        });

  const [admitted, creditResult, { userMemory, oxyUser, entitlements, turnAgent }] =
    await Promise.all([
      admission,
      // Credits: sequential pair (getOrCreate → reserve), parallel with everything else
      // Skip for internal service requests (no credits charged)
      /**
       * A local turn reserves nothing. It is not a discount — no inference of
       * Alia's is spent — and the skip has to be here rather than a refund later:
       * any exit that neither charges nor refunds silently costs the person the
       * reserved credit.
       */
      admission.then((admitted) =>
        admitted.ok && creditAccountId !== undefined && !req.serviceApp && localRuntime === null
          ? (async () => {
              await getOrCreateUserCredits(creditAccountId);
              // The rolling window first (`lib/usage-window.ts`): a turn that
              // would start with it spent reserves nothing and is refused below.
              // It fails OPEN — a window that cannot be read never stops a turn;
              // the balance still bounds it.
              const productCreditSnapshot =
                req.user?.id === creditAccountId
                  ? await readConfiguredProductCreditSnapshot(
                      creditAccountId,
                      req.accessToken,
                    ).catch(() => undefined)
                  : undefined;
              const window = await usageWindowFor(
                creditAccountId,
                productCreditPlanId(productCreditSnapshot, creditAccountId),
              );
              if (window?.exhausted) {
                return { reservation: null, error: false as const, window };
              }
              const priceBook = await captureCreditPriceBook();
              const reservation = await reserveCredits(creditAccountId, undefined, {
                priceBook,
                requestedModel,
                aliaRequestId,
                productCreditSnapshot,
              });
              if (reservation?.productAllocationId)
                reservation.refreshProductCreditSnapshot = () =>
                  readConfiguredProductCreditSnapshot(creditAccountId, req.accessToken);
              return { reservation, error: false as const, window: null };
            })().catch((error) => {
              log.v1.error({ err: error }, 'Error reserving credits');
              return { reservation: null, error: true as const, window: null };
            })
          : {
              reservation: null,
              error: false as const,
              window: null as UsageWindow | null,
            },
      ),

      turnInputs,
    ]);

  log.v1.info({ durationMs: Date.now() - preStreamStart }, 'Pre-stream setup complete');

  /**
   * An attachment the turn may not carry. Nothing was reserved: admission runs
   * before the reservation and the reservation does not run after a refusal.
   */
  if (!admitted.ok) {
    clearTimeout(globalTimer);
    if (sse.sent) {
      sse.writeError(admitted.refusal);
    } else {
      res.status(admitted.status).json({ error: admitted.refusal });
    }
    return null;
  }

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
  /**
   * The plan's rolling window is spent. A 429 the clients already read as a
   * limit to wait out: `retryAfter` is when the oldest spending turn in the
   * window ages out, and it drives the usage dialog's countdown.
   */
  if (creditResult.window?.exhausted) {
    clearTimeout(globalTimer);
    const window = creditResult.window;
    const windowError = {
      message: `You've reached your ${window.hours}-hour usage limit. It frees up as your earlier messages age out.`,
      type: 'rate_limit_error',
      param: null,
      code: 'USAGE_WINDOW_EXCEEDED',
      retryAfter: secondsUntilReset(window),
      suggestedAction: 'wait',
      details: {
        limitType: 'usage_window',
        current: window.used,
        limit: window.limit,
        tier: entitlements?.planId ?? null,
      },
    };
    if (sse.sent) {
      sse.writeError(windowError);
    } else {
      res.status(429).json({ error: windowError });
    }
    return null;
  }

  if (
    req.user &&
    !req.serviceApp &&
    !creditReservation &&
    !creditResult.error &&
    localRuntime === null
  ) {
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
  // The caller's already verified machine bearer reaches only Oxy inference,
  // which revalidates it and derives the application's payer. Never fall back
  // to Alia's process credential for this lane.
  let inferenceServiceToken: string | undefined = machineTurn?.bearer;
  if (linkedAgent?.applicationId != null) {
    const exactApplication = req.serviceApp?.appId === linkedAgent.applicationId;
    /**
     * Two ways a person can be behind a product's service token: an offline
     * delegation grant (its scopes narrow the token), or a present requester
     * whose assertion named exactly this agent (its authority is the person's
     * own, so only the product credential's scopes apply). Payer is the product
     * application either way.
     */
    const presentRequesterForThisAgent =
      isPresentRequesterSession && req.oxyRequester?.agentId === linkedAgent._id;
    const exactDelegation =
      req.user?.id !== undefined &&
      (req.serviceActingAs?.userId === req.user.id || presentRequesterForThisAgent);
    const hasInferenceScope =
      req.serviceApp?.scopes.includes('inference:invoke') === true &&
      (presentRequesterForThisAgent ||
        req.serviceActingAs?.scopes.includes('inference:invoke') === true);
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
    ? await buildTurnSkills({
        oxyUserId: req.user.id,
        linkedAgent,
        selectedSkillNames,
      })
    : null;

  log.v1.info({ provider: resolved.provider, modelId }, 'Using provider');

  const recalledMemories = req.user?.id
    ? await recallTurnMemories({
        oxyUserId: req.user.id,
        conversationId,
        messages,
        modelId,
        selectedSkillNames,
      })
    : undefined;

  return {
    body,
    messages,
    conversationId,
    assistantMessageId,
    reasoningEffort,
    responseMode: body.responseMode === 'voice' ? 'voice' : null,
    host,
    files: admitted.files,
    deepResearch,
    webSearch,
    mcpServerId,
    includeUsage,
    isDirectUserSession,
    requestedModel,
    surface,
    isLocalRuntime: localRuntime !== null,
    clientContext,
    userMemory,
    oxyUser,
    skills: skills ?? EMPTY_SKILL_RUNTIME,
    entitlements,
    linkedAgent,
    inferenceServiceToken,
    creditReservation,
    resolved,
    modelId,
    autonomyRuntime,
    recalledMemories,
  };
}

/**
 * The requester's rolling usage window, or `null` when their plan has none or
 * it cannot be read — the window fails open.
 */
async function usageWindowFor(
  oxyUserId: string,
  productPlanId: string | null = null,
): Promise<UsageWindow | null> {
  try {
    const entitlements = await getUserEntitlements(oxyUserId);
    const legacyPlanId = entitlements?.planId;
    const selected =
      productPlanId &&
      (USAGE_WINDOW_CREDITS.get(productPlanId) ?? 0) >
        (USAGE_WINDOW_CREDITS.get(legacyPlanId ?? 'free') ?? Infinity)
        ? productPlanId
        : legacyPlanId;
    return selected ? await readUsageWindow(oxyUserId, selected) : null;
  } catch (error) {
    log.v1.warn(
      { err: error },
      'Usage window unavailable; the turn goes ahead on the balance alone',
    );
    return null;
  }
}

/** What admitting a turn's attachments came to. */
type AttachmentAdmission =
  | { readonly ok: true; readonly files: ResolvedFiles }
  | {
      readonly ok: false;
      readonly status: number;
      readonly refusal: {
        readonly message: string;
        readonly type: 'invalid_request_error' | 'server_error';
        readonly param: 'messages';
        readonly code: string;
        readonly retryable: boolean;
        readonly feature?: string;
      };
    };

const FEATURE_REFUSAL_MESSAGE: Record<FeatureRefusal['code'], string> = {
  feature_entitlement_required: 'This agent needs an upgrade in its app to read this attachment.',
  feature_check_unavailable:
    'The app that unlocks this attachment could not be asked. Please try again.',
};

function featureRefusal(refusal: FeatureRefusal): AttachmentAdmission {
  return {
    ok: false,
    status: refusal.code === 'feature_entitlement_required' ? 403 : 503,
    refusal: {
      message: FEATURE_REFUSAL_MESSAGE[refusal.code],
      type:
        refusal.code === 'feature_entitlement_required' ? 'invalid_request_error' : 'server_error',
      param: 'messages',
      code: refusal.code,
      feature: refusal.feature,
      retryable: refusal.retryable,
    },
  };
}

/**
 * Check the agent's gates for the parts this turn carries, read every
 * document, then spend each gated part — in that order, so a locked feature
 * downloads nothing and an unreadable document spends nothing. Called before
 * the credit reservation, which it gates.
 */
async function admitAttachments(input: {
  /** The turn's agent, when the request names one. */
  turnAgent: Promise<TurnAgentResolution> | null;
  parts: readonly GatedPart[];
  fileRefs: ReadonlyMap<string, FilePartRef>;
  person: { accountId: string | undefined; accessToken: string | undefined; runId: string };
  modelAcceptsFiles: boolean;
}): Promise<AttachmentAdmission> {
  const resolution = input.turnAgent === null ? null : await input.turnAgent;
  // An agent that did not resolve is refused after admission; it gates nothing.
  const agent = resolution?.kind === 'agent' ? resolution.agent : null;
  const gated = agent === null ? [] : gatedPartsFor(agent, input.parts);
  const person =
    input.person.accountId === undefined
      ? null
      : {
          accountId: input.person.accountId,
          accessToken: input.person.accessToken,
          runId: input.person.runId,
        };

  if (agent !== null && gated.length > 0) {
    if (person === null) {
      return featureRefusal({
        code: 'feature_entitlement_required',
        feature: gated[0].feature,
        retryable: false,
      });
    }
    const locked = await checkGatedParts(agent, person, gated);
    if (locked !== null) return featureRefusal(locked);
  }

  let files: ResolvedFiles;
  try {
    files = await resolveFileParts(input.fileRefs, {
      personAccountId: input.person.accountId,
      accessToken: input.person.accessToken,
      modelAcceptsFiles: input.modelAcceptsFiles,
    });
  } catch (error: unknown) {
    if (!(error instanceof FilePartError)) throw error;
    return {
      ok: false,
      status: 400,
      refusal: {
        message: error.message,
        type: 'invalid_request_error',
        param: 'messages',
        code: error.code,
        retryable: false,
      },
    };
  }

  if (agent !== null && person !== null && gated.length > 0) {
    const refused = await spendGatedParts(agent, person, gated);
    if (refused !== null) return featureRefusal(refused);
  }
  return { ok: true, files };
}
