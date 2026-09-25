/**
 * System Prompt Builder — assembles the complete system message from multiple layers.
 *
 * Replaces the ad-hoc string concatenation scattered across chat-completions.ts.
 * Each injection concern is a named method for clarity and testability.
 */

import { buildIdentityGuard } from './identity-guard.js';
import { getOxyServicePromptFragment, getOxyServiceContext } from './tools/oxy-services.js';
import { agentRemitPrompt } from './agent/archetype-prompts.js';
import { buildAutonomyPromptFragment, type AutonomyRuntimeContext } from './autonomy/runtime.js';
import { buildSystemPrompt as loadBasePrompt, loadPrompt } from './prompt-loader.js';
import type { CatalogueModel } from './models/catalogue.js';

/**
 * Which prompt a turn speaks with, by SURFACE — never by model (ADR 0012).
 *
 * The model is whatever the person picked; how Alia behaves depends on where
 * it is being used. `prompts/<name>.md`, layered over `prompts/base.md`.
 */
export const PROMPT_SURFACES = ['chat', 'codea', 'cowork'] as const;
export type PromptSurface = (typeof PROMPT_SURFACES)[number];
const SURFACE_PROMPTS: Readonly<Record<PromptSurface, string>> = {
  chat: 'general',
  codea: 'codea',
  cowork: 'cowork',
};

/**
 * The spoken-answer layer, selected by the REQUEST (`responseMode: 'voice'`).
 *
 * A voice call is a chat turn: it keeps the model and tools the conversation
 * chose and asks for an answer meant to be heard. `prompts/voice.md` says what
 * that is — short, no formatting, nothing that reads badly aloud — and it is
 * layered over the surface prompt rather than replacing it.
 */
const SPOKEN_ANSWER_PROMPT = 'voice';
import { log } from './logger.js';
import { agentPromptName, type HydratedAgent } from './agent-identity.js';
import { readCapabilityGrants } from '../domain/capability-grants.js';
import type { IWritingStyleProfile } from '../domain/writing-style.js';
import { formatStyleForPrompt } from './style/style-prompt.js';
import { agentMemoryPromptSection } from './agent/agent-memory-runtime.js';

/** How many recent memories stand in for recall when recall returned nothing. */
const KNOWN_FACTS_WITHOUT_RECALL = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserMemoryData {
  memories?: Array<{ title: string; summary: string }>;
  preferences?: Record<string, any>;
  context?: Record<string, any>;
  /**
   * The person's memory settings. Only `recallEnabled` is read here — the
   * switch the app labels "Use in AI responses" — and only for the writing
   * style; see layer 7b.
   */
  settings?: { recallEnabled?: boolean };
  /** The learned writing-style profile (`user_memories.writing_style`). */
  writingStyle?: IWritingStyleProfile | null;
}

export interface OxyUserProfile {
  name?: { full?: string; first?: string };
  username?: string;
}

/** A built system prompt and how many of its characters each measured part holds. */
export interface SystemPromptParts {
  text: string;
  /** Recalled memories and the person's own memory (facts, preferences, context). */
  memoryChars: number;
  /** The installed skills' index and the skills active on this turn. */
  skillsChars: number;
}

export interface SystemPromptOptions {
  /** The surface whose prompt the turn speaks with. Defaults to `chat`. */
  surface?: PromptSurface;
  /** The catalogue model answering, when hosted; named in the identity guard. */
  model?: CatalogueModel | null;
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
  skills?: { index: string; active: string; agentScoped?: boolean } | null;
  /** Linked agent (for archetype prompt injection) */
  linkedAgent?: HydratedAgent | null;
  /** Whether agent mode is active */
  agentMode?: boolean;
  /**
   * `'voice'` when the turn was spoken in a voice call and will be read aloud.
   * Layers `prompts/voice.md` over the base prompt; see `SPOKEN_ANSWER_PROMPT`.
   */
  responseMode?: 'voice' | null;
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
   *   9. User memory (facts, preferences, context), then the person's
   *      learned writing style
   *  10. Skills index (name and description of each installed skill)
   */
  static async build(opts: SystemPromptOptions): Promise<string> {
    return (await SystemPromptBuilder.buildMeasured(opts)).text;
  }

  /**
   * The same prompt, with how much of it is the person's memory and how much
   * the skills — the context-window breakdown's own categories, measured where
   * they are added rather than guessed afterwards.
   */
  static async buildMeasured(opts: SystemPromptOptions): Promise<SystemPromptParts> {
    let memoryChars = 0;
    let skillsChars = 0;
    const {
      surface = 'chat',
      model,
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
      responseMode,
    } = opts;

    /**
     * Prompt context and executable tools share one authority decision.
     *
     * The tool pipeline has always read `capabilityGrants` deny-by-default,
     * but this builder used to append the person's memories, profile, connected
     * Inbox context and communication/delegation hints independently. That made
     * an agent with no grants unable to CALL a memory tool while still reading
     * the same memory in its system prompt. A capability boundary applies to
     * information as well as effects, so every user-owned prompt fragment is
     * gated from this same parsed set.
     *
     * Ordinary Alia has no linked agent and remains unpartitioned.
     */
    const agentGrants = linkedAgent
      ? readCapabilityGrants(linkedAgent.capabilityGrants ?? [])
      : null;
    const mayReadMemory = agentGrants === null || agentGrants.allows('memory');
    const mayUseMessaging = agentGrants === null || agentGrants.allows('messaging');
    const mayDelegate = agentGrants === null || agentGrants.allows('delegation');
    const mayReadSkills = agentGrants === null || skills?.agentScoped === true;

    // 1. Base prompt: the surface's prompt over `base.md`.
    let systemMessage = await loadBasePrompt(SURFACE_PROMPTS[surface], clientContext);

    // 1b. A spoken answer, when the turn came from a voice call — last of the
    // style layers, because how the answer will be DELIVERED overrides how the
    // surface would format it on screen.
    if (responseMode === 'voice') {
      const spoken = await loadPrompt(SPOKEN_ANSWER_PROMPT);
      if (spoken !== '') systemMessage += `\n\n---\n\n${spoken}`;
    }

    // 2. Current date
    systemMessage += `\n\nToday is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;

    // 3. Autonomy fragment
    if (autonomyRuntime) {
      systemMessage += buildAutonomyPromptFragment(autonomyRuntime);
    }

    // 4. Recalled memories from hooks
    if (mayReadMemory && recalledMemories?.length) {
      const memoryLines = recalledMemories.slice(0, 12).map((m) => `- ${m.title}: ${m.summary}`).join('\n');
      const recalled = `\n\n## Recalled Memories\n${memoryLines}`;
      systemMessage += recalled;
      memoryChars += recalled.length;
    }

    // 6. User-specific injections (direct sessions only)
    if (isDirectUserSession) {
      // User name
      const userName = oxyUser?.name?.full || oxyUser?.name?.first || oxyUser?.username;
      if (agentGrants === null && userName) {
        systemMessage += `\n\nThe user's name is ${userName}.`;
      }

      // Communication tools hint
      if (mayUseMessaging) {
        systemMessage += '\n\nYou have `sendTelegramMessage` and WhatsApp tools (`getWhatsAppChats`, `getWhatsAppMessages`, `sendWhatsAppMessage`). Use them when the user asks. For WhatsApp, call getWhatsAppChats first to get chat JIDs.';
      }

      // Oxy service context (non-blocking). Agent access to Oxy apps is decided
      // by normalized DelegationGrant assignments in `buildOxyServiceTools`,
      // not by the person's direct-session context. Until that resolver returns
      // a prompt-safe projection, exposing the person's Inbox context here
      // would be a second, ungoverned authorization path.
      if (agentGrants === null && userId && accessToken) {
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
      if (agentMode && mayDelegate) {
        systemMessage += '\n\nAGENT MODE: You have `searchAgents` and `delegateToAgent` tools. Search for specialist agents, delegate to the best match, and briefly explain why. If no agent fits, handle it yourself.';
      }
    }

    // 7. User memory (direct sessions only)
    if (mayReadMemory && userMemory && isDirectUserSession) {
      const beforeUserMemory = systemMessage.length;
      systemMessage += '\n\n## User Information';

      // Recall chose the relevant memories above; dumping every one here as
      // well defeated it and grew the prompt with the person's whole history.
      // Without a recall result, the most recent few stand in for it. A person
      // who switched recall off gets neither.
      const recallOff = userMemory.settings?.recallEnabled === false;
      const knownFacts = recallOff || recalledMemories?.length ? [] : (userMemory.memories ?? []).slice(-KNOWN_FACTS_WITHOUT_RECALL);
      if (knownFacts.length > 0) {
        systemMessage += '\n### Known Facts:\n' + knownFacts.map(m => `- ${m.title}: ${m.summary}`).join('\n');
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
      memoryChars += systemMessage.length - beforeUserMemory;
    }

    /**
     * 7b. The person's learned writing style.
     *
     * `style-learning-hook.ts` has built this profile after every chat since it
     * was written, and `routes/writing-style.ts` lets the person read, edit and
     * reset it — but nothing ever put it in front of the model, so the whole
     * feature was a settings screen describing something that did nothing.
     *
     * Gated exactly as the memory above is — a direct session, and an agent only
     * with the `memory` grant — because it IS memory: something learned about a
     * person from their own messages. A developer key or a product service
     * token acting for somebody never receives it, for the same reason they
     * never receive the facts.
     *
     * And additionally on `recallEnabled`, the switch the app shows as "Use in
     * AI responses": a person who turned that off asked for what Alia learned
     * about them to stay out of its answers, and a style profile is exactly
     * that. Not gated on `autoSaveEnabled`, which governs what is SAVED, not
     * what is read.
     *
     * The block bounds its own size (`STYLE_PROMPT_MAX_CHARS`) and is empty for
     * a profile that is not ready yet, so an empty string adds nothing.
     */
    if (
      mayReadMemory
      && isDirectUserSession
      && userMemory
      && userMemory.settings?.recallEnabled !== false
    ) {
      const style = formatStyleForPrompt(userMemory.writingStyle ?? null);
      if (style !== '') systemMessage += `\n\n${style}`;
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
    if (mayReadSkills && skills?.index) {
      systemMessage += skills.index;
      skillsChars += skills.index.length;
    }
    if (mayReadSkills && skills?.active) {
      systemMessage = `${skills.active}\n\n---\n\n${systemMessage}`;
      skillsChars += skills.active.length;
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
    // The agent's OWN memory of this person, under the same grant as the rest.
    if (linkedAgent && mayReadMemory && userId && isDirectUserSession) {
      systemMessage += await agentMemoryPromptSection(userId, linkedAgent._id);
    }

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
      modelName: model?.name,
      publisherName: model?.publisher.name,
    })}\n\n---\n\n${systemMessage}`;

    return { text: systemMessage, memoryChars, skillsChars };
  }
}
