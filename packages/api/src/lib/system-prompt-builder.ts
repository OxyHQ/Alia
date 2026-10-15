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

/** The rule for asking the person through `askUserQuestion`; see `SystemPromptOptions.askUserQuestion`. */
const ASK_USER_QUESTION_PROMPT = 'ask-user-question';

/**
 * Cowork's rules for its own `browser_action` client tool. The client names the
 * tool, so the rules are loaded only for a turn whose tool set carries it.
 */
const COWORK_BROWSER_PROMPT = 'cowork-browser';
const COWORK_BROWSER_TOOL = 'browser_action';
import { log } from './logger.js';
import { agentPromptName, type HydratedAgent } from './agent-identity.js';
import { readCapabilityGrants } from '../domain/capability-grants.js';
import type { IWritingStyleProfile } from '../domain/writing-style.js';
import { formatStyleForPrompt } from './style/style-prompt.js';
import { agentMemoryPromptSection } from './agent/agent-memory-runtime.js';
import { memoryDataBlock, memoryFactLines } from './memory/memory-prompt.js';

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
  /**
   * The names of the tools registered for THIS turn, the client's own included.
   * Prompt text that names a tool is loaded only when the tool is in this list,
   * so the prompt never describes a tool the model was not given.
   */
  toolNames?: readonly string[];
  /**
   * `'voice'` when the turn was spoken in a voice call and will be read aloud.
   * Layers `prompts/voice.md` over the base prompt; see `SPOKEN_ANSWER_PROMPT`.
   */
  responseMode?: 'voice' | null;
  /**
   * Whether `askUserQuestion` is registered for THIS turn (`ASK_USER_QUESTION_TOOL`
   * in the assembled tool set). Layers `prompts/ask-user-question.md`, which tells
   * the model to put a choice on the card instead of writing it as prose. Only the
   * tool's presence may switch it on: a client with no card (developer key, bot,
   * non-streaming) would otherwise be told to call a tool it does not have. Ignored
   * for a spoken turn, which cannot draw a card.
   */
  askUserQuestion?: boolean;
  /** Autonomy runtime context */
  autonomyRuntime?: AutonomyRuntimeContext | null;
  /**
   * The Apps section from `ToolPipeline.forUser` (`appCatalogPrompt`): the
   * connected apps this turn may open with `useApps` when its tools do not all
   * fit in one request. Empty when they do.
   */
  appCatalog?: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class SystemPromptBuilder {
  /**
   * Build the complete system message from all layers.
   *
   * Layer order, top to bottom. STATIC first, so a provider's prefix cache
   * can serve the head of the message; per-turn content last.
   *
   *   0. Identity guard (the ONLY layer that says who the assistant is, and the
   *      only one that carries an agent's remit rule) — nothing below can
   *      override it
   *   1. Agent remit, then the skills selected for this message
   *   2. Surface prompt + `base.md`, then the client-tool, spoken-answer and
   *      question-card layers — how to answer, never who is answering
   *   3. Oxy apps description, then the Apps catalogue
   *   4. Skills index
   *   -- volatile from here --
   *   5. Date, autonomy fragment, recalled memories
   *   6. The person's name and inbox context, memory, learned writing style,
   *      and an agent's own memory
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
      toolNames,
      autonomyRuntime,
      responseMode,
      appCatalog,
      askUserQuestion,
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
    /**
     * Memory is per actor. Alia's memory of the person (recall, facts,
     * preferences, context, writing style) is read by ALIA only; an agent with
     * the `memory` grant reads its OWN memory of the person
     * (`agentMemoryPromptSection`) and nothing of hers.
     */
    const mayReadAliaMemory = agentGrants === null;
    const mayReadAgentMemory = agentGrants !== null && agentGrants.allows('memory');
    const mayReadSkills = agentGrants === null || skills?.agentScoped === true;

    // 1. Base prompt: the surface's prompt over `base.md`.
    let systemMessage = await loadBasePrompt(SURFACE_PROMPTS[surface], clientContext);

    // 1a. A client tool the surface prompt has rules for, only when it is registered.
    if (surface === 'cowork' && toolNames?.includes(COWORK_BROWSER_TOOL)) {
      const browser = await loadPrompt(COWORK_BROWSER_PROMPT);
      if (browser !== '') systemMessage += `\n\n---\n\n${browser}`;
    }

    // 1b. A spoken answer, when the turn came from a voice call — last of the
    // style layers, because how the answer will be DELIVERED overrides how the
    // surface would format it on screen.
    if (responseMode === 'voice') {
      const spoken = await loadPrompt(SPOKEN_ANSWER_PROMPT);
      if (spoken !== '') systemMessage += `\n\n---\n\n${spoken}`;
    }

    // 1c. How to ask the person, when the card tool is in this turn's tool set —
    // beside the base prompt's Ambiguity and Tools sections it qualifies.
    if ((askUserQuestion || toolNames?.includes('askUserQuestion')) && responseMode !== 'voice') {
      const ask = await loadPrompt(ASK_USER_QUESTION_PROMPT);
      if (ask !== '') systemMessage += `\n\n---\n\n${ask}`;
    }

    /**
     * Everything above, up to the volatile block below, is the same bytes on
     * every turn of a conversation (and across conversations that share a
     * surface, model and tool set), so a provider's prefix cache can serve it.
     * Per-turn content — the date, the autonomy classification, the person's
     * name and memory, recalled memories — goes AFTER it, never inside.
     */

    // 2. Oxy service description (non-blocking). Agent access to Oxy apps is
    // decided by normalized DelegationGrant assignments in `buildOxyServiceTools`,
    // not by the person's direct-session context. Until that resolver returns
    // a prompt-safe projection, exposing the person's Inbox context here
    // would be a second, ungoverned authorization path.
    let oxyServiceCtx = '';
    if (isDirectUserSession && agentGrants === null && userId && accessToken) {
      try {
        const [oxyServicePrompt, ctx] = await Promise.all([
          getOxyServicePromptFragment(userId),
          getOxyServiceContext(userId, accessToken),
        ] as const);
        // A routed turn lists every Oxy app in its Apps section (3) with how
        // to open it. The fragment names their tools as if they were already
        // in the tool list, which, while they are not, reads to a weak model
        // as "those tools do not exist" — and it refuses.
        if (oxyServicePrompt && !appCatalog) systemMessage += oxyServicePrompt;
        oxyServiceCtx = ctx;
      } catch {
        // Non-critical — don't block chat
      }
    }

    /**
     * 3. The connected apps this turn can open (`lib/tool-budget.ts`).
     *
     * Ungated by session kind: it describes tools the assembler already
     * authorized for THIS turn, so whoever the turn is for may know they exist —
     * and without it an app that is not open yet is invisible to the model.
     */
    if (appCatalog) systemMessage += appCatalog;

    // 4. Skills index: a list of names and descriptions the model reads to decide
    // whether to call `loadSkill`. Not gated on `isDirectUserSession`:
    // authorization is an install owned by the caller's account, and a developer
    // key carries its owner's — so nothing here leaks one account's material
    // into another's request.
    if (mayReadSkills && skills?.index) {
      systemMessage += skills.index;
      skillsChars += skills.index.length;
    }

    // ---- Volatile block: changes per turn, so it comes last. ----

    // 5. Current date
    systemMessage += `\n\nToday is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;

    // 6. Autonomy fragment
    if (autonomyRuntime) {
      systemMessage += buildAutonomyPromptFragment(autonomyRuntime);
    }

    // 7. Recalled memories from hooks
    if (mayReadAliaMemory && recalledMemories?.length) {
      const recalled = memoryDataBlock(
        'Recalled Memories',
        memoryFactLines(recalledMemories.slice(0, 12)),
      );
      systemMessage += recalled;
      memoryChars += recalled.length;
    }

    // 8. The person (direct sessions only).
    if (isDirectUserSession) {
      const userName = oxyUser?.name?.full || oxyUser?.name?.first || oxyUser?.username;
      if (agentGrants === null && userName) {
        systemMessage += `\n\nThe user's name is ${userName}.`;
      }
      if (oxyServiceCtx) systemMessage += oxyServiceCtx;
    }

    // 9. User memory (direct sessions only) — Alia's, as labelled data.
    if (mayReadAliaMemory && userMemory && isDirectUserSession) {
      // Recall chose the relevant memories above; dumping every one here as
      // well defeated it and grew the prompt with the person's whole history.
      // Without a recall result, the most recent few stand in for it. A person
      // who switched recall off gets neither.
      const recallOff = userMemory.settings?.recallEnabled === false;
      const knownFacts =
        recallOff || recalledMemories?.length
          ? []
          : (userMemory.memories ?? []).slice(-KNOWN_FACTS_WITHOUT_RECALL);
      const parts: string[] = [];
      if (knownFacts.length > 0) {
        parts.push('### Known Facts:\n' + memoryFactLines(knownFacts));
      }
      if (userMemory.preferences && Object.keys(userMemory.preferences).length > 0) {
        const prefs = Object.entries(userMemory.preferences)
          .filter(([k, v]) => v !== undefined && v !== null && k !== 'language')
          .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        if (prefs.length > 0) {
          parts.push('### User Preferences:\n' + prefs.join('\n'));
        }
      }
      if (userMemory.context && Object.keys(userMemory.context).length > 0) {
        const ctx = Object.entries(userMemory.context)
          .filter(([_, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `- ${k}: ${v}`);
        if (ctx.length > 0) {
          parts.push('### Context:\n' + ctx.join('\n'));
        }
      }
      const block = memoryDataBlock('User Information', parts.join('\n'));
      systemMessage += block;
      memoryChars += block.length;
    }

    /**
     * 9b. The person's learned writing style.
     *
     * Gated exactly as the memory above is — a direct session, and Alia only
     * (an agent keeps its own memory) — because it IS memory: something learned
     * about a person from their own messages. A developer key or a product
     * service token acting for somebody never receives it, for the same reason
     * they never receive the facts.
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
      mayReadAliaMemory &&
      isDirectUserSession &&
      userMemory &&
      userMemory.settings?.recallEnabled !== false
    ) {
      const style = formatStyleForPrompt(userMemory.writingStyle ?? null);
      if (style !== '') systemMessage += `\n\n${style}`;
    }

    // The agent's OWN memory of this person, under the same grant as the rest.
    if (linkedAgent && mayReadAgentMemory && userId && isDirectUserSession) {
      systemMessage += await agentMemoryPromptSection(userId, linkedAgent._id);
    }

    // The skills the person selected for this message are PREPENDED, above the
    // base prompt, where a skill can shape how the turn is answered.
    if (mayReadSkills && skills?.active) {
      systemMessage = `${skills.active}\n\n---\n\n${systemMessage}`;
      skillsChars += skills.active.length;
      log.general.info({ chars: skills.active.length }, 'Skills activated');
    }

    /**
     * The agent's remit (prepended — wraps everything including the skill).
     *
     * Unconditional: an agent with no prompt of its own would otherwise get a
     * NAME from the guard and no description of itself, which is the "it
     * answers everything" bug. {@link agentRemitPrompt} always has something to
     * say; the guard's remit rule points at what it says. Keyed on
     * `linkedAgent` alone, exactly as the guard below is, so the two cannot
     * disagree.
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
      modelName: model?.name,
      publisherName: model?.publisher.name,
    })}\n\n---\n\n${systemMessage}`;

    return { text: systemMessage, memoryChars, skillsChars };
  }
}
