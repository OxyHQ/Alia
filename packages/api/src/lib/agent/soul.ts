/**
 * Agent SOUL System
 *
 * Inspired by TinyClaw's SOUL.md, this module provides structured personality
 * for agents that evolves through their interactions.
 *
 * The SOUL separates an agent's identity into dimensions:
 * - vibe: Communication style ("witty", "formal", "concise")
 * - expertise: Demonstrated expertise areas (evolves over time)
 * - worldview: Core principles ("pragmatic", "user-first")
 * - currentFocus: What the agent has been working on recently
 *
 * Evolution runs on ~10% of interactions using kaana-lite to keep costs minimal.
 */

import { generateText } from 'ai';
import { getDb } from '../../db/index.js';
import {
  bumpAgentSoulInteractions,
  evolveAgentSoul as persistSoulEvolution,
  findAgentById,
  type AgentSoul,
} from '../../db/agents/agentRepository.js';
import { resolveModel, getAIModel } from '../chat-core.js';
import { log } from '../logger.js';

// ============== FORMATTING ==============

/**
 * Format an agent's soul into a natural-language section for the system prompt.
 */
export function formatSoul(soul: AgentSoul): string {
  const sections: string[] = [];

  if (soul.vibe.length > 0) {
    sections.push(`Communication style: ${soul.vibe.join(', ')}`);
  }

  if (soul.expertise.length > 0) {
    sections.push(`Areas of expertise: ${soul.expertise.join(', ')}`);
  }

  if (soul.worldview.length > 0) {
    sections.push(`Core principles: ${soul.worldview.join(', ')}`);
  }

  if (soul.currentFocus.length > 0) {
    sections.push(`Currently focused on: ${soul.currentFocus.join(', ')}`);
  }

  if (sections.length === 0) return '';

  return `\n## Your Identity\n${sections.join('\n')}`;
}

// ============== EVOLUTION ==============

const EVOLUTION_PROMPT = `Analyze this agent interaction and extract updates to the agent's personality profile.

Agent's task: {{TASK}}
Agent's response (summary): {{RESPONSE}}

Return a JSON object with ONLY fields that should be updated (omit unchanged fields):
{
  "newExpertise": ["topic1"],     // NEW expertise areas demonstrated (max 3)
  "currentFocus": ["focus1"],     // What the agent is currently working on (max 3, replaces old)
  "newVibe": ["trait1"]           // NEW communication traits observed (max 2)
}

Rules:
- Only include genuinely new or different items, not things already known
- Keep items short (1-3 words each)
- If nothing new was demonstrated, return {}
- Respond ONLY with the JSON object, no other text`;

/**
 * The caps `$slice` applied, and the direction it applied them in.
 *
 * `$slice: [..., -15]` keeps the LAST fifteen — the most recently demonstrated
 * expertise — which is what the repository reproduces. The numbers live here,
 * beside the prompt that produces the values they bound, rather than inside the
 * statement that applies them.
 */
const SOUL_CAPS = { expertise: 15, vibe: 8 } as const;

/** What the evolution model is allowed to contribute in one turn. */
const PER_TURN_LIMITS = { expertise: 3, currentFocus: 3, vibe: 2 } as const;

/** A bounded list of short strings, or nothing. Anything else is discarded. */
function stringList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item !== '');
  return items.length > 0 ? items.slice(0, max) : undefined;
}

/**
 * Evolve an agent's soul based on a completed interaction.
 *
 * Runs on kaana-lite for cost efficiency. Fire-and-forget.
 *
 * The model's answer is parsed into a KNOWN shape rather than spread: it is
 * generated text reaching a write path, and the columns behind it are `text[]`.
 * A non-array, or an array of objects, would previously have been handed
 * straight to `$addToSet`.
 *
 * @param agentId - The agent's id
 * @param task - The task that was delegated
 * @param response - The agent's response text
 */
export async function evolveAgentSoul(
  agentId: string,
  task: string,
  response: string,
): Promise<void> {
  try {
    const db = getDb();
    const agent = await findAgentById(db, agentId);
    if (!agent) return;

    const newCount = (agent.soul?.interactionCount ?? 0) + 1;

    const prompt = EVOLUTION_PROMPT
      .replace('{{TASK}}', task.slice(0, 500))
      .replace('{{RESPONSE}}', response.slice(0, 500));

    // kaana-lite, for the cheapest possible evolution.
    const resolved = await resolveModel('kaana-lite');
    if (!resolved) {
      await bumpAgentSoulInteractions(db, agentId, newCount);
      return;
    }

    const result = await generateText({
      model: getAIModel(resolved, 'agent_run'),
      prompt,
      maxOutputTokens: 200,
      temperature: 0.3,
    });

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      await bumpAgentSoulInteractions(db, agentId, newCount);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      await bumpAgentSoulInteractions(db, agentId, newCount);
      return;
    }

    const updates = parsed as Record<string, unknown>;
    const currentFocus = stringList(updates.currentFocus, PER_TURN_LIMITS.currentFocus);
    const newExpertise = stringList(updates.newExpertise, PER_TURN_LIMITS.expertise);
    const newVibe = stringList(updates.newVibe, PER_TURN_LIMITS.vibe);

    await persistSoulEvolution(
      db,
      agentId,
      {
        interactionCount: newCount,
        lastEvolvedAt: new Date(),
        ...(currentFocus !== undefined && { currentFocus }),
        ...(newExpertise !== undefined && { newExpertise }),
        ...(newVibe !== undefined && { newVibe }),
      },
      SOUL_CAPS,
    );

    log.general.info(
      {
        agentId,
        oxyAccountId: agent.oxyAccountId,
        newCount,
        hasUpdates:
          currentFocus !== undefined || newExpertise !== undefined || newVibe !== undefined,
      },
      'Agent soul evolved',
    );
  } catch (err) {
    log.general.error({ err, agentId }, 'Agent soul evolution failed');
  }
}
