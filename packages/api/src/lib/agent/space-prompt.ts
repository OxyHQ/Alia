/**
 * What an agent that is in a SPACE (ADR 0028) is told about it, wherever it is spoken to: a chat with
 * the person, a background run, its own Telegram bot. The room has its own, richer framing
 * (`roomPrompt`); this is the part every surface shares, so a member knows it belongs to a team and what
 * the team is for even when only the person is talking to it.
 */

import { getDb } from '../../db/index.js';
import { findSpaceBrief } from '../../db/spaces/spaceRepository.js';

/** The section itself, pure. Starts with a blank line so it can be appended to the agent's remit. */
export function spaceSection(space: { name: string; instructions: string }): string {
  const purpose =
    space.instructions === ''
      ? ''
      : ` What the space is for, in the person's words:\n\n${space.instructions}`;
  return `\n\n## Your space\nYou are part of the space "${space.name}", with other agents of the same person. You share its workspace and its group chat, and you deal only with them, with the person, and with Alia.${purpose}`;
}

/** The section for this agent, or '' when it is in no space (or its space has just been deleted). */
export async function agentSpacePrompt(agent: { spaceId: string | null }): Promise<string> {
  if (!agent.spaceId) return '';
  const space = await findSpaceBrief(getDb(), agent.spaceId);
  return space ? spaceSection(space) : '';
}
