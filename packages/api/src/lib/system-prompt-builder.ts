/**
 * System Prompt Builder — assembles the complete system message from multiple layers.
 *
 * Replaces the ad-hoc string concatenation scattered across chat-completions.ts.
 * Each injection concern is a named method for clarity and testability.
 */

import { getAliaModel } from './gateway-client.js';
import { buildIdentityGuard } from './identity-guard.js';
import { getOxyServicePromptFragment, getOxyServiceContext } from './tools/oxy-services.js';
import { buildArchetypeSystemPrompt } from './agent/archetype-prompts.js';
import { buildAutonomyPromptFragment, type AutonomyRuntimeContext } from './autonomy/runtime.js';
import { buildSystemPrompt as loadBasePrompt } from './prompt-loader.js';
import { log } from './logger.js';
import type { IAgent } from '../models/agent.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserMemoryData {
  memories?: Array<{ key: string; value: string }>;
  preferences?: Record<string, any>;
  context?: Record<string, any>;
}

export interface OxyUserProfile {
  name?: { full?: string; first?: string };
  username?: string;
}

export interface SystemPromptOptions {
  /** Resolved Alia model ID (e.g. "alia-v1") */
  aliasModelId: string;
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
  recalledMemories?: Array<{ key: string; value: string }>;
  /** Active skill document */
  skill?: { title?: string; systemPrompt?: string } | null;
  /** Linked agent (for archetype prompt injection) */
  linkedAgent?: IAgent | null;
  /** Whether agent mode is active */
  agentMode?: boolean;
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
   *      agent, or downstream fragment can override the Alia identity boundary)
   *   1. Skill / Agent archetype (prepended — wraps the base prompt)
   *   2. Base prompt (model-specific identity + capabilities)
   *   3. Date injection
   *   4. Autonomy fragment
   *   5. Recalled memories
   *   6. Model identity
   *   7. User profile & communication tools hint
   *   8. Oxy service description + context
   *   9. Agent mode hint
   *  10. User memory (facts, preferences, context)
   */
  static async build(opts: SystemPromptOptions): Promise<string> {
    const {
      aliasModelId,
      clientContext,
      isDirectUserSession,
      userId,
      accessToken,
      oxyUser,
      userMemory,
      recalledMemories,
      skill,
      linkedAgent,
      agentMode,
      autonomyRuntime,
    } = opts;

    // 1. Base prompt
    let systemMessage = await loadBasePrompt(aliasModelId, clientContext);

    // 2. Current date
    systemMessage += `\n\nToday is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;

    // 3. Autonomy fragment
    if (autonomyRuntime) {
      systemMessage += buildAutonomyPromptFragment(autonomyRuntime);
    }

    // 4. Recalled memories from hooks
    if (recalledMemories?.length) {
      const memoryLines = recalledMemories.slice(0, 12).map((m) => `- ${m.key}: ${m.value}`).join('\n');
      systemMessage += `\n\n## Recalled Memories\n${memoryLines}`;
    }

    // 5. Model identity
    const aliaModel = await getAliaModel(aliasModelId);
    if (aliaModel) {
      systemMessage += `\n\nYou are currently using the **${aliaModel.name}** model. When asked what model you use, say you are using ${aliaModel.name}.`;
    }

    // 6. User-specific injections (direct sessions only)
    if (isDirectUserSession) {
      // User name
      const userName = oxyUser?.name?.full || oxyUser?.name?.first || oxyUser?.username;
      if (userName) {
        systemMessage += `\n\nThe user's name is ${userName}.`;
      }

      // Communication tools hint
      systemMessage += '\n\nYou have `sendTelegram` and WhatsApp tools (`getWhatsAppChats`, `getWhatsAppMessages`, `sendWhatsAppMessage`). Use them when the user asks. For WhatsApp, call getWhatsAppChats first to get chat JIDs.';

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
        systemMessage += '\n### Known Facts:\n' + userMemory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
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

    // 8. Skill prompt (prepended — wraps everything)
    if (skill?.systemPrompt && isDirectUserSession) {
      systemMessage = `# ACTIVE SKILL: ${skill.title}\n\n${skill.systemPrompt}\n\n---\n\n${systemMessage}`;
      log.general.info({ skillTitle: skill.title }, 'Skill activated');
    }

    // 9. Agent archetype prompt (prepended — wraps everything including skill)
    if (linkedAgent && isDirectUserSession) {
      const agentPrompt = linkedAgent.systemPrompt || buildArchetypeSystemPrompt(linkedAgent);
      if (agentPrompt) {
        systemMessage = `# AGENT: ${linkedAgent.name}\n\n${agentPrompt}\n\n---\n\n${systemMessage}`;
        log.general.info({ agentName: linkedAgent.name, archetype: linkedAgent.archetype }, 'Agent prompt injected');
      }
    }

    // 0. Identity guard — prepended LAST so it sits above the skill/agent
    // prompts and every other layer. Nothing downstream can override the
    // Alia identity boundary.
    systemMessage = `${buildIdentityGuard(aliaModel?.name)}\n\n---\n\n${systemMessage}`;

    return systemMessage;
  }
}
