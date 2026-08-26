/**
 * THE tool assembler. There is exactly one, and `__tests__/one-assembler.test.ts`
 * is what keeps it that way.
 *
 * ## What it replaced, and what that cost
 *
 * There were FIVE, with no shared code: this one, `buildChatTools`
 * (`services/chat.service.ts`, the Telegram path), `buildActions`
 * (`lib/agent/actions.ts`, the autonomous runner), `buildTriggerTools`
 * (`lib/trigger-engine.ts`) and an inline `ToolSet` literal in
 * `routes/internal.ts` that no census over exported names could see.
 *
 * They diverged in ways nobody chose:
 *
 *  - Only THIS one included `buildOxyServiceTools`, so an agent answering on
 *    its owner's Telegram bot could not reach a single first-party Oxy service.
 *  - Only `buildChatTools` included `canvas` and the four trigger-management
 *    tools, so the main chat could not create a trigger and Telegram could.
 *  - The Telegram tool had TWO NAMES for one factory — `sendTelegram` here,
 *    `sendTelegramMessage` in the other three — so a prompt or a skill naming
 *    one silently did nothing on the other paths. `sendTelegramMessage` won.
 *  - `buildTriggerTools` contributed nothing of its own at all: a pure subset.
 *
 * The collapse is a UNION, not an intersection. A capability that existed on
 * any path exists on all of them now, and what still differs does so because it
 * has a structural precondition — an SSE emitter to push events through, a live
 * container and browser to act on, a device to describe — never because of
 * which function happened to build the set.
 *
 * ## The agent is an INPUT, and its GRANTS are what partition the set
 *
 * `agent` says whose turn this is. Before, the only identity in scope was
 * `userId`, so an agent saw exactly what its owner saw and no partition was
 * expressible. `agent.capabilityGrants` is that partition, and it is the only
 * input that decides what an agent may reach.
 *
 * Two properties follow, and both are behaviour changes worth stating:
 *
 *  - **An agent with no grants gets nothing** beyond `UNGRANTED_TOOLS`. The
 *    three vocabularies this replaced all defaulted the other way — a NULL
 *    `permissions` column meant ALLOWED — so an agent nobody had configured
 *    reached everything its owner could. `domain/capability-grants.ts` argues
 *    the reversal.
 *  - **A turn with NO agent is untouched.** Ordinary Alia has no grants to read
 *    and reaches whatever its surface structurally allows, exactly as before;
 *    `GRANTS_EVERYTHING` is what says so, and it is deliberately not the same
 *    value as "an agent granted every family" — an agent's set can never answer
 *    `null` to an instance question, so a missing agent cannot be mistaken for
 *    a fully-granted one.
 *
 * The grant is read at the point each tool is BUILT, never filtered out
 * afterwards. A filter would need its own copy of which tool belongs to which
 * family, free to drift from the vocabulary; and for the instanced families it
 * would mean fetching a connector's tools in order to discard them.
 */

import type { ToolSet } from 'ai';
import {
  getCurrentDateTool,
  webSearchTool,
  browseTool,
  webScraperTool,
  generateFileTool,
  saveUserMemoryTool,
  updateUserMemoryTool,
  updateUserPreferencesTool,
  updateUserContextTool,
  createSearchThreadTool,
  createSendTelegramTool,
  createGetWhatsAppChatsTool,
  createGetWhatsAppMessagesTool,
  createSendWhatsAppMessageTool,
  createSearchAgentsTool,
  createDelegateToAgentTool,
  createAgentTool,
  createDeepResearchTool,
  createSwitchModelTool,
  createPlanPreviewTool,
  createSuggestNewConversationTool,
} from './tools/index.js';
import { buildMcpTools } from './tools/mcp.js';
import { buildAskAgentTool } from './tools/ask-agent.js';
import { buildIntegrationTools } from './tools/integrations.js';
import { buildOxyServiceTools } from './tools/oxy-services.js';
import { convertOpenAIToolsToToolSet, type OpenAITool } from './tool-converter.js';
import { log } from './logger.js';
import type { SSEEmitter } from './sse-emitter.js';
import type { HydratedAgent } from './agent-identity.js';
import {
  GRANTS_EVERYTHING,
  readCapabilityGrants,
  type CapabilityGrantSet,
  type InstancedCapabilityFamily,
} from '../domain/capability-grants.js';
import type { DeviceInfo } from './tools/device-info.js';
import {
  applyRuntimePolicy,
  buildRuntimeTools,
  type AgentRuntimeContext,
} from './agent/actions.js';
import { canvasTool } from './tools/canvas.js';
import { createGetDeviceInfoTool } from './tools/device-info.js';
import {
  createTriggerTool,
  listTriggersTool,
  updateTriggerTool,
  deleteTriggerTool,
} from './tools/trigger-management.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForUserOptions {
  userId: string;
  accessToken?: string;
  /**
   * The caller holds a live user SESSION — an Oxy bearer, not an `alia_sk_` key.
   *
   * Governs only what needs that bearer to exist: minting an agent under the
   * caller's own Oxy tree, and the agent-mode search and delegation tools.
   */
  isDirectSession: boolean;
  /**
   * Whether this turn acts for a specific PERSON and may touch their own data.
   *
   * The distinction `isDirectSession` could not make, and the reason the four
   * assemblers diverged: Telegram, a trigger and an autonomous run all act for
   * a real person while holding no session of their own, so each rebuilt the
   * personal tool set by hand and each ended up with a different one.
   *
   * FALSE for an API-key turn. A developer key carries its owner's `userId`, so
   * every one of these tools would compile and run — and would hand a key
   * HOLDER the key OWNER's memory, WhatsApp threads and triggers. That is what
   * `isDirectSession` was standing in for here, and it is now said directly.
   */
  actsForPerson: boolean;
  agentMode: boolean;
  requestId?: string;
  /**
   * Whether this turn may use tools AT ALL. No default: every caller states it.
   *
   * The one caller that says `false` is a trigger whose author opted out
   * (`trigger.action.useTools`), and what it gets is the date and nothing else
   * — which is what `buildTriggerTools` did, preserved rather than reasoned
   * away. A default would make the opt-out something a new call site forgets.
   */
  toolsEnabled: boolean;
  /**
   * The agent this turn is FOR, already resolved and authorised.
   *
   * Present on a turn that named one, absent on ordinary Alia. It is an input
   * rather than something worked out from `userId` — see the file comment.
   */
  agent?: HydratedAgent | null;
  /**
   * The device on the other end, when the surface knows it.
   *
   * A structural precondition: `getDeviceInfo` can only describe a device that
   * was described to us. Came from `buildChatTools`, whose Telegram caller has
   * one and whose other callers did not.
   */
  deviceInfo?: DeviceInfo | null;
  /**
   * A live autonomous-agent session: its container, its browser, its plan.
   *
   * The other structural precondition. `shell`, `browser`, `file_edit`, `plan`
   * and `delegate` act ON these objects, so they exist only for a turn that has
   * them — which is the runner's, and no other. Absent everywhere else, and
   * that is why they are not simply always-on like the rest.
   */
  runtime?: AgentRuntimeContext | null;
  /** Raw OpenAI-format tools from the client (VS Code, Cursor, Cowork) */
  editorToolDefinitions?: OpenAITool[];
  /** SSE emitter for tools that need to push events (switchModel, planPreview) */
  sseEmitter?: SSEEmitter;
  /**
   * Whether this turn may reach the open web.
   *
   * `false` withholds the three tools that fetch from it. Withholding is the
   * only honest implementation of an off switch here: the model decides whether
   * to call a tool, so leaving `webSearch` in the set and asking the prompt not
   * to use it would be a switch the model may overrule.
   */
  webSearch: boolean;
  /**
   * Whether the turn is served by the caller's own device, and therefore
   * reserved no credits.
   *
   * What it withholds is not "expensive tools" in general — it is the ONE tool
   * in this set that reaches inference Alia pays for. `deepResearch` runs
   * `lib/research/research-engine.ts`, which resolves `alia-lite` and `alia-v1`
   * by name; offered on an unreserved turn it is free hosted inference behind a
   * tool call. The matching request FLAGS are refused at the boundary
   * (`lib/chat/request-context.ts`), and `delegateToAgent` needs `agentMode`,
   * which is refused there too — so this is the remaining door.
   *
   * Everything else here stays: the web tools reach DuckDuckGo's free endpoint,
   * and the rest touch the person's own data.
   */
  isLocalRuntime: boolean;
  /**
   * The INSTANCED families this caller will actually use.
   *
   * `undefined` means all four, which is every caller that existed before
   * this. `[]` means none, and the four sources are then not FETCHED at all.
   *
   * ## It is a fetch decision, never a permission one
   *
   * Nothing here can widen what a turn may reach: the grants already decided
   * that, and this can only narrow further. It exists because a caller that is
   * going to DISCARD connector tools should not pay three network round trips
   * to build them first — and `routes/v1/voice.ts` is exactly that: a channel
   * with no surface for a connector's output, on a path where somebody is
   * waiting to speak.
   *
   * `mcpServerId` still narrows WITHIN `mcp` when `mcp` is in the set; the two
   * answer different questions — which families to fetch at all, and which
   * connector the person picked.
   */
  instancedSources?: readonly InstancedCapabilityFamily[];
  /**
   * One hosted MCP connector selected for this turn, by the person composing it.
   *
   * `undefined` keeps the compatibility behaviour (all runnable connectors),
   * `null` exposes none, and a string exposes only that owned connector.
   *
   * SEPARATE from the agent's grants, and narrower than either alone: this is
   * one turn's choice, the grants are a standing property of the agent, and
   * what reaches `buildMcpTools` is the intersection. A composer pick the agent
   * was not granted exposes nothing.
   */
  mcpServerId?: string | null;
}

export interface ForUserResult {
  tools: ToolSet;
  /** Maps sanitized tool names back to original names (for Google Gemini compat) */
  toolNameMapping: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Tool Pipeline
// ---------------------------------------------------------------------------

export class ToolPipeline {
  /**
   * Assemble the complete tool set for a turn — chat, Telegram, trigger or
   * autonomous run.
   */
  static async forUser(opts: ForUserOptions): Promise<ForUserResult> {
    const {
      userId,
      accessToken,
      isDirectSession,
      actsForPerson,
      agentMode,
      toolsEnabled,
      agent,
      deviceInfo,
      runtime,
      requestId,
      editorToolDefinitions,
      sseEmitter,
      webSearch,
      mcpServerId,
      isLocalRuntime,
      instancedSources,
    } = opts;

    const toolNameMapping = new Map<string, string>();

    /**
     * What this turn may reach, family by family.
     *
     * A turn with no agent is ordinary Alia and is not partitioned at all. A
     * turn WITH one reaches only what its owner granted, and an agent whose
     * owner has granted nothing reaches nothing — see the file comment.
     */
    const grants: CapabilityGrantSet =
      agent === undefined || agent === null
        ? GRANTS_EVERYTHING
        : readCapabilityGrants(agent.capabilityGrants);

    /**
     * A trigger whose author opted out of tools gets the date and nothing else.
     *
     * Returned before anything is fetched, so an opted-out trigger costs no MCP
     * round trip either — which is what `buildTriggerTools` did by never
     * reaching its own fetch, and is preserved here rather than reasoned away.
     */
    if (!toolsEnabled) {
      return { tools: { getCurrentDate: getCurrentDateTool }, toolNameMapping };
    }

    // 1. Convert editor tools from OpenAI format and build name mapping
    const editorTools = Array.isArray(editorToolDefinitions)
      ? convertOpenAIToolsToToolSet(editorToolDefinitions, toolNameMapping)
      : {};

    /**
     * 2. Static tools (server-executed).
     *
     * `getCurrentDate` is ungranted — it is the clock, and it is already
     * unconditional above for a trigger that switched tools off entirely.
     * `generateFile` and `canvas` both produce something to RENDER rather than
     * writing anywhere, which is why they are one family and why neither sits
     * with `file_edit`.
     */
    const aliaTools: ToolSet = { getCurrentDate: getCurrentDateTool };
    if (grants.allows('artifacts')) {
      aliaTools.generateFile = generateFileTool;
      aliaTools.canvas = canvasTool;
    }

    /**
     * The web reaches this turn only if it was asked for.
     *
     * These three were unconditional, and the composer's "Web search" switch
     * toggled a local `Set` that reached no request field and no backend read —
     * so the switch was meaningless in both directions at once: it could not
     * enable searching (already on) and could not disable it (no flag). The
     * flag exists now and this is what it does.
     */
    if (webSearch && grants.allows('web')) {
      aliaTools.webSearch = webSearchTool;
      aliaTools.webScraper = webScraperTool;
      aliaTools.browse = browseTool;
    }

    // A device can only be described when the surface knows one.
    if (deviceInfo) aliaTools.getDeviceInfo = createGetDeviceInfoTool(deviceInfo);

    /**
     * 3. Tools bound to the PERSON. Every surface that acts for one gets them,
     * and only those.
     *
     * The gate used to be `isDirectSession`, which conflated "has a bearer"
     * with "acts for somebody" — so Telegram, triggers and the runner, which
     * act for a person without holding a session, each rebuilt a subset by hand
     * and each ended up with a different one. See {@link ForUserOptions.actsForPerson}
     * for why an API-key turn must still be refused here.
     */
    if (actsForPerson) {
      if (grants.allows('memory')) {
        Object.assign(aliaTools, {
          saveUserMemory: saveUserMemoryTool(userId),
          updateUserMemory: updateUserMemoryTool(userId),
          updateUserPreferences: updateUserPreferencesTool(userId),
          updateUserContext: updateUserContextTool(userId),
        });
        /**
         * Only for a turn that HAS an agent, because a thread is a (person,
         * agent) pair and there is nothing to search without one. Ordinary
         * Alia has no thread, so it gets no `searchThread` — the structural
         * precondition, the same shape as `deviceInfo` and `runtime`.
         *
         * The agent is closed over, never offered to the model.
         */
        if (agent !== undefined && agent !== null) {
          aliaTools.searchThread = createSearchThreadTool(userId, agent._id);
        }
      }
      if (grants.allows('messaging')) Object.assign(aliaTools, {
        /**
         * ONE name. It was `sendTelegram` here and `sendTelegramMessage` on the
         * other three paths, for the same factory — so a prompt or a skill
         * naming one silently did nothing on the other. The three-way spelling
         * wins, and it is the one `lib/agent/tool-router.ts` already maps.
         */
        sendTelegramMessage: createSendTelegramTool(userId),
        getWhatsAppChats: createGetWhatsAppChatsTool(userId),
        getWhatsAppMessages: createGetWhatsAppMessagesTool(userId),
        sendWhatsAppMessage: createSendWhatsAppMessageTool(userId),
      });
      if (grants.allows('automation')) Object.assign(aliaTools, {
        createTrigger: createTriggerTool(userId),
        listTriggers: listTriggersTool(userId),
        updateTrigger: updateTriggerTool(userId),
        deleteTrigger: deleteTriggerTool(userId),
      });
      // `web`, not a family of its own: what it does is read the open web, and
      // it is withheld from an unreserved turn for the reason `isLocalRuntime`
      // gives above.
      if (webSearch && !isLocalRuntime && grants.allows('web')) {
        aliaTools.deepResearch = createDeepResearchTool(userId);
      }
    }

    // Minting an agent needs the caller's own credential, so only a session has it.
    if (isDirectSession && grants.allows('delegation')) {
      aliaTools.createAgent = createAgentTool(userId, accessToken);
    }

    /**
     * SSE-emitting tools: they need an emitter to push through AND a client
     * that renders what comes out.
     *
     * `isDirectSession` as well as the emitter, because both events drive
     * Alia's own composer — a model switch chip and a plan preview — and a
     * developer-key client (Codea, Cowork) has no surface for either. Offering
     * them there is a tool the model can call whose whole effect is a frame
     * nobody draws.
     */
    if (sseEmitter && isDirectSession) {
      aliaTools.switchModel = await createSwitchModelTool((modelId, modelName) => {
        sseEmitter.emit('alia.model_switch', { eventVersion: 1, model: modelId, modelName });
      });
      aliaTools.planPreview = createPlanPreviewTool((steps) => {
        sseEmitter.emit('alia.plan_preview', { eventVersion: 1, planId: `plan-${requestId}`, steps });
      });
      /**
       * Built per turn, which is what makes its once-per-turn bound real: the
       * closure that remembers it already fired lives in the factory, and the
       * factory runs here.
       */
      aliaTools.suggestNewConversation = createSuggestNewConversationTool((suggestion) => {
        // Spread rather than passed: `SSEEmitter.emit` takes an index
        // signature, which a closed interface does not satisfy. The frame is
        // the same two fields either way.
        sseEmitter.emit('alia.suggest_new_conversation', { ...suggestion });
      });
    }

    // The session primitives: only a turn with a live session can act on one,
    // and only the families it was granted — the source decides, not a filter.
    if (runtime) Object.assign(aliaTools, buildRuntimeTools(runtime, grants));

    /**
     * 4. The bulk sources — the FOUR INSTANCED FAMILIES. All of them, on every
     * surface.
     *
     * `buildOxyServiceTools` used to be here alone, so an agent answering on
     * its owner's Telegram bot could not reach one first-party Oxy service —
     * the divergence this collapse exists to end.
     *
     * Three of the four build their tool NAMES from rows — `mcp_x__y`,
     * `oxy_x__y`, and an integration the person connected — so nobody could
     * enumerate them when the vocabulary was written and a whole-family grant
     * would be a blank cheque over rows that do not exist yet. That is exactly
     * what an agent inheriting all of its owner's connectors was, and it is why
     * those three are granted one row at a time.
     *
     * `agent` is the fourth, and its rows are the person's OWN agents: one tool
     * whose schema names exactly the ones this turn may talk to. It is here
     * rather than beside `delegateToAgent` below because the selection is a
     * database read, and reading it in parallel with the other three is the
     * difference between one round trip and four in series. It is under
     * `actsForPerson` for the same reason the three are — and that is also what
     * bounds the recursion, since a nested agent turn does not act for a person
     * and therefore never receives this tool.
     *
     * A grant of nothing means NOT FETCHING rather than fetching and
     * discarding: an empty selection short-circuits inside each source, so an
     * agent granted no connector costs no round trip and no cache entry.
     */
    /**
     * A family the CALLER declined is not fetched, which is the whole point of
     * `instancedSources`: three round trips to build tools that are about to be
     * thrown away is latency somebody is standing in.
     */
    const wants = (family: InstancedCapabilityFamily): boolean =>
      instancedSources === undefined || instancedSources.includes(family);

    const [mcpTools, integrationTools, oxyServiceTools, ownAgentTools] = actsForPerson
      ? await Promise.all([
          wants('mcp')
            ? buildMcpTools(userId, mcpSelection(mcpServerId, grants)).catch(bulkFailure('mcp'))
            : {},
          wants('integration')
            ? buildIntegrationTools(userId, grants.instances('integration') ?? undefined)
                .catch(bulkFailure('integration'))
            : {},
          accessToken === undefined || !wants('oxy_service')
            ? {}
            : buildOxyServiceTools(userId, accessToken, grants.instances('oxy_service') ?? undefined)
                .catch(bulkFailure('oxy-service')),
          wants('agent')
            ? buildAskAgentTool(userId, ownAgentSelection(grants, agent, userId), agent?._id ?? null)
                .catch(bulkFailure('agent'))
            : {},
        ])
      : [{}, {}, {}, {}];
    Object.assign(aliaTools, mcpTools, integrationTools, oxyServiceTools, ownAgentTools);

    // 5. Merge server tools with editor tools
    const tools: ToolSet = { ...aliaTools, ...editorTools };

    // 6. Agent mode: add search & delegation tools
    if (agentMode && isDirectSession && grants.allows('delegation')) {
      tools.searchAgents = createSearchAgentsTool();
      // The delegating account pays for the delegate's turn; see `agent-turn.ts`.
      tools.delegateToAgent = createDelegateToAgentTool(userId);
    }

    /**
     * 7. The runtime policy, LAST and over everything.
     *
     * The permission stubs and the threat detector are about what an agent may
     * DO, so they run over the whole assembled set — MCP tools included — and
     * only for a turn that has a runtime, which is where they have always run.
     */
    if (runtime) await applyRuntimePolicy(tools, runtime, new Set(Object.keys(mcpTools)));

    return { tools, toolNameMapping };
  }
}

/**
 * Which of the owner's own agents this turn may talk to.
 *
 * `undefined` is every ACTIVE one, resolved by the source at the moment it is
 * asked — a bare `agent` grant, or a turn with no agent at all. An array is the
 * ids the owner named, and `[]` reaches none and costs no query.
 *
 * ## A grant written by one owner cannot resolve against another's agents
 *
 * An agent whose `access` is `public` runs inside a STRANGER's turn, where
 * `userId` is the stranger. Per-id grants handle that on their own — the source
 * scopes rows to `userId`, so ids naming the author's agents match nothing —
 * but "every active agent" would silently re-point at whoever is talking, and
 * hand an agent its own conversation partner's private agents.
 *
 * So the bare grant resolves only when the turn's user IS the agent's author.
 * Under anyone else it reaches none, which is the same answer the per-id form
 * already gives, rather than a different one for the same grant.
 */
function ownAgentSelection(
  grants: CapabilityGrantSet,
  agent: HydratedAgent | null | undefined,
  userId: string,
): readonly string[] | undefined {
  const granted = grants.instances('agent');
  if (granted !== null) return granted;
  if (agent === undefined || agent === null) return undefined;
  return agent.author === userId ? undefined : [];
}

/**
 * The MCP connectors this turn may reach: the composer's pick AND the grants.
 *
 * Two allow-lists over one set, and the answer is their intersection. They mean
 * different things — `pick` is one turn's choice from Alia's composer, the
 * grants are a standing property of the agent — so neither can stand in for the
 * other, and a pick the agent was not granted has to expose nothing rather than
 * override the grant.
 *
 * `undefined` survives only when BOTH sides are unrestricted, which is a turn
 * with no agent and no pick: that is the one case that still means every
 * runnable connector, local relay servers included.
 */
function mcpSelection(
  pick: string | null | undefined,
  grants: CapabilityGrantSet,
): readonly string[] | undefined {
  const granted = grants.instances('mcp');
  if (pick === null) return [];
  if (granted === null) return pick === undefined ? undefined : [pick];
  return pick === undefined ? granted : granted.filter((id) => id === pick);
}

/**
 * A bulk source that could not be loaded contributes NOTHING, loudly.
 *
 * One source failing used to take the other two with it: all three shared a
 * `Promise.all` inside a single `try`, so an MCP connector being down cost the
 * turn its integrations and its Oxy services as well. Catching per source is
 * what makes "the connector is down" a smaller event than "the turn has no
 * tools".
 */
function bulkFailure(source: string): (err: unknown) => ToolSet {
  return (err: unknown) => {
    log.general.warn({ err, source }, 'A tool source failed to load; the turn continues without it');
    return {};
  };
}
