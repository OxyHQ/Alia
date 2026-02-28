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
 * Evolution runs on ~10% of interactions using alia-lite to keep costs minimal.
 */

import { generateText } from 'ai';
import { Agent } from '../models/agent.js';
import { resolveModel, getAIModel } from './chat-core.js';
import { log } from './logger.js';

// ============== TYPES ==============

export interface AgentSoul {
  vibe: string[];
  expertise: string[];
  worldview: string[];
  currentFocus: string[];
  interactionCount: number;
  lastEvolvedAt: Date | null;
}

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
 * Evolve an agent's soul based on a completed interaction.
 * Runs on alia-lite for cost efficiency. Fire-and-forget.
 *
 * @param agentId - The agent's MongoDB ID
 * @param task - The task that was delegated
 * @param response - The agent's response text
 */
export async function evolveAgentSoul(
  agentId: string,
  task: string,
  response: string,
): Promise<void> {
  try {
    const agent = await Agent.findById(agentId).select('soul name').lean();
    if (!agent) return;

    const soul: AgentSoul = agent.soul || {
      vibe: [],
      expertise: [],
      worldview: [],
      currentFocus: [],
      interactionCount: 0,
      lastEvolvedAt: null,
    };

    // Increment interaction count
    const newCount = (soul.interactionCount || 0) + 1;

    // Build the evolution prompt
    const prompt = EVOLUTION_PROMPT
      .replace('{{TASK}}', task.slice(0, 500))
      .replace('{{RESPONSE}}', response.slice(0, 500));

    // Resolve alia-lite for cheapest possible evolution
    const resolved = await resolveModel('alia-lite');
    if (!resolved) {
      // Just update interaction count
      await Agent.updateOne(
        { _id: agentId },
        { $set: { 'soul.interactionCount': newCount } },
      );
      return;
    }

    const model = getAIModel(resolved.keyConfig);

    const result = await generateText({
      model,
      prompt,
      maxOutputTokens: 200,
      temperature: 0.3,
    });

    // Parse the evolution response
    let updates: any;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        await Agent.updateOne(
          { _id: agentId },
          { $set: { 'soul.interactionCount': newCount } },
        );
        return;
      }
      updates = JSON.parse(jsonMatch[0]);
    } catch {
      await Agent.updateOne(
        { _id: agentId },
        { $set: { 'soul.interactionCount': newCount } },
      );
      return;
    }

    // Apply updates
    const $set: Record<string, any> = {
      'soul.interactionCount': newCount,
      'soul.lastEvolvedAt': new Date(),
    };

    if (updates.currentFocus?.length) {
      $set['soul.currentFocus'] = updates.currentFocus.slice(0, 3);
    }

    const $addToSet: Record<string, any> = {};

    if (updates.newExpertise?.length) {
      $addToSet['soul.expertise'] = { $each: updates.newExpertise.slice(0, 3) };
    }

    if (updates.newVibe?.length) {
      $addToSet['soul.vibe'] = { $each: updates.newVibe.slice(0, 2) };
    }

    const updateOp: Record<string, any> = { $set };
    if (Object.keys($addToSet).length > 0) {
      updateOp.$addToSet = $addToSet;
    }

    await Agent.updateOne({ _id: agentId }, updateOp);

    // Cap arrays to prevent unbounded growth
    await Agent.updateOne({ _id: agentId }, [
      {
        $set: {
          'soul.expertise': { $slice: ['$soul.expertise', -15] },
          'soul.vibe': { $slice: ['$soul.vibe', -8] },
        },
      },
    ]);

    log.general.info(
      { agentId, agentName: agent.name, newCount, hasUpdates: Object.keys(updates).length > 0 },
      'Agent soul evolved',
    );
  } catch (err) {
    log.general.error({ err, agentId }, 'Agent soul evolution failed');
  }
}
