/**
 * System Prompt Builder — assembles the complete system message from multiple layers.
 *
 * Replaces the ad-hoc string concatenation scattered across chat-completions.ts.
 * Each injection concern is a named method for clarity and testability.
 */

import { getRoutingProfile } from './gateway-client.js';
import { buildIdentityGuard } from './identity-guard.js';
import { getOxyServicePromptFragment, getOxyServiceContext } from './tools/oxy-services.js';
import { agentRemitPrompt } from './agent/archetype-prompts.js';
import { buildAutonomyPromptFragment, type AutonomyRuntimeContext } from './autonomy/runtime.js';
import { buildSystemPrompt as loadBasePrompt, loadPrompt } from './prompt-loader.js';
import { getProductPromptId } from './product-prompt-registry.js';
import type { EffortLevel } from './reasoning-effort.js';

/**
 * The extended-reasoning layer, selected by the effort LEVEL rather than by a
 * model id (#139 workstream 4).
 *
 * `kaana-v1-thinking` and `kaana-v1-pro-max` route to the same nine candidates at
 * the same price and differed only in which of these files their id loaded, so
 * the reasoning level was an identity when it should have been a setting. It is
 * a setting now, and any profile can carry it.
 *
 * ## It is no longer the only thing reasoning does
 *
 * This prompt layer used to be the WHOLE feature: the two provider hooks that
 * were supposed to carry `thinkingMode` wrote AI SDK v4 option names against an
 * `ai@6` install, so asking for reasoning changed a paragraph of the system
 * message and nothing else. `lib/chat/model-config.ts` sends a real budget now,
 * and this layer sits beside it rather than standing in for it.
 *
 * Added at every level ABOVE `instant`, not at one particular level: it tells
 * the model to reason carefully, which is what a person choosing any of the
 * three dearer levels asked for. The levels differ in the BUDGET they buy, and
 * that difference is made by the provider option rather than by three
 * variously-worded prompts.
 *
 * The fragment has a product-semantic name, independent from the routing
 * profile that may select it.
 */
const EXTENDED_REASONING_PROMPT = 'extended-reasoning';
import { log } from './logger.js';
import { agentPromptName, type HydratedAgent } from './agent-identity.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserMemoryData {
  memories?: Array<{ title: string; summary: string }>;
  preferences?: Record<string, any>;
  context?: Record<string, any>;
}

export interface OxyUserProfile {
  name?: { full?: string; first?: string };
  username?: string;
}

export interface SystemPromptOptions {
  /** Canonical Kaana routing profile (for example, `kaana-v1`). */
  routingProfileId: string;
  /** Client context string (UI language, etc.) */
  clientContext?: string;
  /** Whether this is a direct user session (not API key) */
  isDirectUserSession: boolean;
  /** User ID (OxyHQ) */
  userId?: string;
  /** User's access token (for Oxy service context) */
  accessToken?: string;
  /** User profile from OxyHQ */
  oxyUser?: OxyUserProfile | null;
  /** User's persistent memory */
  userMemory?: UserMemoryData | null;
  /** Recalled memories from before-chat hooks */
  recalledMemories?: Array<{ title: string; summary: string }>;
  /**
   * The two halves of Agent Skills that reach the system prompt.
   *
   * `index` is level one — every installed skill's name and description, which
   * is how the model knows one exists at all. `active` is level two for skills
   * the person selected for this message: their instructions, in full.
   *
   * They land in different places, and the difference is authority. An index is
   * CONTEXT and is appended with everything else Alia knows; instructions the
   * person asked for are prepended, above the base prompt, where a skill can
   * shape how the turn is answered. Neither goes above the identity guard.
   */
  skills?: { index: string; active: string } | null;
  /** Linked agent (for archetype prompt injection) */
  linkedAgent?: HydratedAgent | null;
  /** Whether agent mode is active */
  agentMode?: boolean;
  /**
   * How hard the request asked this turn to think — the runtime parameter that
   * replaced `kaana-v1-thinking` as a model identity. Any profile can carry it,
   * which is the whole point of it being a parameter.
   */
  reasoningEffort?: EffortLevel | null;
  /** Autonomy runtime context */
  autonomyRuntime?: AutonomyRuntimeContext | null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class SystemPromptBuilder {
  /**
   * Build the complete system message from all layers.
   *
   * Layer order (bottom-up):
   *   0. Identity guard (prepended LAST — sits at the absolute top so no skill,
   *      agent, or downstream fragment can override it). The ONLY layer that
   *      says who the assistant is, and the only one that carries an agent's
   *      remit rule.
   *   1. Selected skills / agent remit (prepended — wrap the base prompt)
   *   2. Base prompt (the style profile for the chosen model, plus `base.md`) —
   *      how to answer, never who is answering
   *   3. Date injection
   *   4. Autonomy fragment
   *   5. Recalled memories
   *   6. User profile & communication tools hint
   *   7. Oxy service description + context
   *   8. Agent mode hint
   *   9. User memory (facts, preferences, context)
   *  10. Skills index (name and description of each installed skill)
   */
  static async build(opts: SystemPromptOptions): Promise<string> {
    const {
      routingProfileId,
      clientContext,
      isDirectUserSession,
      userId,
      accessToken,
      oxyUser,
      userMemory,
      recalledMemories,
      skills,
      linkedAgent,
      agentMode,
      autonomyRuntime,
      reasoningEffort,
    } = opts;

    /**
     * 1. Base prompt, selected through the product prompt registry.
     *
     * `loadPrompt` reads `prompts/<name>.md`; the registry deliberately keeps
     * that product-owned name independent from the canonical Kaana profile.
     *
     * An identifier the registry does not cover keeps today's behaviour — it is
     * passed through, `loadPrompt` finds no file, and the turn runs on
     * `base.md` alone.
     */
    const productPromptId = getProductPromptId(routingProfileId);
    let systemMessage = await loadBasePrompt(productPromptId ?? routingProfileId, clientContext);

    // 1b. Extended reasoning, when the request asked for it.
    //
    // Do not layer it twice when the selected profile's primary product prompt
    // is already the extended-reasoning fragment.
    if (
      reasoningEffort != null
      && reasoningEffort !== 'instant'
      && productPromptId !== EXTENDED_REASONING_PROMPT
    ) {
      const reasoning = await loadPrompt(EXTENDED_REASONING_PROMPT);
      if (reasoning !== '') systemMessage += `\n\n---\n\n${reasoning}`;
    }

    // 2. Current date
    systemMessage += `\n\nToday is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;

    // 3. Autonomy fragment
    if (autonomyRuntime) {
      systemMessage += buildAutonomyPromptFragment(autonomyRuntime);
    }

    // 4. Recalled memories from hooks
    if (recalledMemories?.length) {
      const memoryLines = recalledMemories.slice(0, 12).map((m) => `- ${m.title}: ${m.summary}`).join('\n');
      systemMessage += `\n\n## Recalled Memories\n${memoryLines}`;
    }

    /**
     * 5. The active model, READ rather than restated.
     *
     * This layer used to append "You are currently using the **Kaana V1**
     * model. When asked what model you use, say you are using Kaana V1" — which
     * the guard at the top already says, in both its branches. On an agent's
     * turn it was a second "You are …" sentence naming something other than the
     * agent, sitting below the one that named the agent. Two owners of one
     * fact; the guard is the owner, and this now only feeds it the name.
     */
    const routingProfile = await getRoutingProfile(routingProfileId);

    // 6. User-specific injections (direct sessions only)
    if (isDirectUserSession) {
      // User name
      const userName = oxyUser?.name?.full || oxyUser?.name?.first || oxyUser?.username;
      if (userName) {
        systemMessage += `\n\nThe user's name is ${userName}.`;
      }

      // Communication tools hint
      systemMessage += '\n\nYou have `sendTelegramMessage` and WhatsApp tools (`getWhatsAppChats`, `getWhatsAppMessages`, `sendWhatsAppMessage`). Use them when the user asks. For WhatsApp, call getWhatsAppChats first to get chat JIDs.';

      // Oxy service context (non-blocking)
      if (userId && accessToken) {
        try {
          const [oxyServicePrompt, oxyServiceCtx] = await Promise.all([
            getOxyServicePromptFragment(userId),
            getOxyServiceContext(userId, accessToken),
          ] as const);
          if (oxyServicePrompt) systemMessage += oxyServicePrompt;
          if (oxyServiceCtx) systemMessage += oxyServiceCtx;
        } catch {
          // Non-critical — don't block chat
        }
      }

      // Agent mode hint
      if (agentMode) {
        systemMessage += '\n\nAGENT MODE: You have `searchAgents` and `delegateToAgent` tools. Search for specialist agents, delegate to the best match, and briefly explain why. If no agent fits, handle it yourself.';
      }
    }

    // 7. User memory (direct sessions only)
    if (userMemory && isDirectUserSession) {
      systemMessage += '\n\n## User Information';

      if (userMemory.memories && userMemory.memories.length > 0) {
        systemMessage += '\n### Known Facts:\n' + userMemory.memories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
      }
      if (userMemory.preferences && Object.keys(userMemory.preferences).length > 0) {
        const prefs = Object.entries(userMemory.preferences)
          .filter(([k, v]) => v !== undefined && v !== null && k !== 'language')
          .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        if (prefs.length > 0) {
          systemMessage += '\n### User Preferences:\n' + prefs.join('\n');
        }
      }
      if (userMemory.context && Object.keys(userMemory.context).length > 0) {
        const ctx = Object.entries(userMemory.context)
          .filter(([_, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `- ${k}: ${v}`);
        if (ctx.length > 0) {
          systemMessage += '\n### Context:\n' + ctx.join('\n');
        }
      }
    }

    // 8. Skills.
    //
    // The index is appended as context: a list of names and descriptions the
    // model reads to decide whether to call `loadSkill`. The selected skills'
    // instructions are prepended, because the person chose them for this turn.
    //
    // Not gated on `isDirectUserSession`, unlike the single prompt this
    // replaces. Authorization is an install owned by the caller's account, and a
    // developer key carries its owner's — so there is nothing here that leaks
    // one account's material into another's request.
    if (skills?.index) {
      systemMessage += skills.index;
    }
    if (skills?.active) {
      systemMessage = `${skills.active}\n\n---\n\n${systemMessage}`;
      log.general.info({ chars: skills.active.length }, 'Skills activated');
    }

    /**
     * 9. The agent's remit (prepended — wraps everything including the skill).
     *
     * Unconditional now, where it used to be `systemPrompt || archetype` behind
     * an `if`. An agent with neither — the default shape of anything created
     * through `POST /agents` without a prompt — got a NAME from the guard above
     * and no description of itself anywhere, which is the "it answers
     * everything" half of the reported bug. {@link agentRemitPrompt} always has
     * something to say; the guard's remit rule points at what it says.
     *
     * Keyed on `linkedAgent` ALONE, where it also asked `isDirectUserSession`.
     * The guard below never asked — so the two conditions disagreeing produced
     * exactly the shape this change exists to remove: a turn told it is Claudio
     * with nothing describing Claudio. Unreachable today, because
     * `lib/chat/request-context.ts` only resolves an agent for a direct
     * session, which is why this is a trap removed rather than a behaviour
     * changed.
     */
    if (linkedAgent) {
      systemMessage = `${agentRemitPrompt(linkedAgent)}\n\n---\n\n${systemMessage}`;
      log.general.info(
        { agentName: agentPromptName(linkedAgent), archetype: linkedAgent.archetype },
        'Agent prompt injected',
      );
    }

    // 0. Identity guard — prepended LAST so it sits above the skill/agent
    // prompts and every other layer. Nothing downstream can override the
    // Alia identity boundary.
    // An agent's turn says the AGENT's name and carries the remit rule; an
    // ordinary turn says the model's and stays general-purpose.
    systemMessage = `${buildIdentityGuard({
      ...(linkedAgent ? { agentName: agentPromptName(linkedAgent) } : {}),
      modelName: routingProfile?.name,
    })}\n\n---\n\n${systemMessage}`;

    return systemMessage;
  }
}
