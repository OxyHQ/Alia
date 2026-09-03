/**
 * Switch Model Tool
 *
 * Lets the AI move the conversation to a different routing profile when it
 * decides the question needs different capabilities. Sends an
 * `alia.model_switch` SSE event so the frontend can update the selector.
 *
 * ## It switches between POLICIES, not between model names
 *
 * The targets are `profile:*` ids — the same identifiers `GET /catalogue`
 * serves and the same ones a client sends as `model`. It used to offer five
 * `alia-*` names, two of which (`kaana-v1-thinking` and `kaana-v1-pro-max`) are
 * one profile differing only in the system prompt their id selects, so the AI
 * could "switch models" and change nothing but a prompt. One entry per policy
 * removes that move entirely.
 *
 * ## What it advertises is what it accepts
 *
 * The description the model reads, the parameter's own doc and the guard all
 * come from ONE source, `OFFERED_PROFILES`. They used to be two hand-written
 * lists beside a guard that consulted neither, so the tool could advertise a
 * target it would then refuse. The per-target blurbs come from the catalogue
 * rather than from literals, for the same reason: they previously hardcoded
 * credit multipliers into a prompt string, which is a price list that goes
 * stale silently — nothing fails, the model just quotes a wrong number.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getRoutingProfile } from '../gateway-client.js';
import { OFFERED_PROFILES, isProfileOffered } from '../product-modes.js';
import { log } from '../logger.js';

/**
 * One line per offered policy, read from the catalogue.
 *
 * A profile the catalogue cannot describe is listed by id alone rather than
 * dropped: the id is the contract and it is known from a const, so a failed
 * catalogue read must not silently shrink what the AI may choose between.
 */
async function describeOfferedProfiles(): Promise<string> {
  const lines = await Promise.all(
    OFFERED_PROFILES.map(async (profileId) => {
      const model = await getRoutingProfile(profileId).catch((err: unknown) => {
            log.tools.warn({ err, profileId }, 'Catalogue unavailable while describing switchModel targets');
            return null;
          });
      if (model === null) return `- ${profileId}`;
      return `- ${profileId}: ${model.description} (${model.creditMultiplier}x credits)`;
    }),
  );
  return lines.join('\n');
}

/**
 * Create a switchModel tool.
 *
 * @param onSwitch Callback fired when the AI switches — use to send the SSE event.
 */
export async function createSwitchModelTool(onSwitch: (modelId: string, modelName: string) => void) {
  const offeredList = OFFERED_PROFILES.join(', ');
  return tool({
    description:
      'Switch this conversation to a different routing profile. Use when the current ' +
      'question needs capabilities beyond the current one. Available profiles:\n' +
      `${await describeOfferedProfiles()}\n` +
      'Only switch when the task clearly benefits from a different profile.',
    inputSchema: z.object({
      model: z.string().describe(`Routing profile to switch to. One of: ${offeredList}.`),
      reason: z.string().describe('Brief reason for switching'),
    }),
    execute: async ({ model, reason }) => {
      if (!isProfileOffered(model)) {
        // Covers a legacy `alia-*` name as well as a typo. Both are answered by
        // naming what the product actually offers, because an error that does
        // not say what to send instead is not actionable.
        return { error: `"${model}" is not a routing profile this product offers. Available: ${offeredList}.` };
      }

      const routingProfile = await getRoutingProfile(model);
      if (!routingProfile) {
        return { error: `"${model}" is unavailable right now. Available: ${offeredList}.` };
      }

      log.tools.info({ profile: model, modelName: routingProfile.name, reason }, 'AI switched routing profile');
      onSwitch(model, routingProfile.name);

      return {
        switched: true,
        model,
        modelName: routingProfile.name,
        message: `Switched to ${routingProfile.name}. Future messages in this conversation will use this profile.`,
      };
    },
  });
}
