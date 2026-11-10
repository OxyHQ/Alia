/**
 * What an agent that is in a SPACE (ADR 0028) is told about it, wherever it is spoken to: a chat with
 * the person, a background run, its own Telegram bot. The room has its own, richer framing
 * (`roomPrompt`); this is the part every surface shares, so a member knows it belongs to a team and what
 * the team is for even when only the person is talking to it.
 */

import { getDb } from '../../db/index.js';
import { readSpaceNotes } from '../../db/spaces/spaceMemoryRepository.js';
import { findSpaceBrief } from '../../db/spaces/spaceRepository.js';
import { memoryDataBlock } from '../memory/memory-prompt.js';
import { AGENT_MEMORY_INDEX, agentMemoryPromptSlice } from './memory-contract.js';

/** The section itself, pure. Starts with a blank line so it can be appended to the agent's remit. */
export function spaceSection(space: { name: string; instructions: string }): string {
  const purpose =
    space.instructions === ''
      ? ''
      : ` What the space is for, in the person's words:\n\n${space.instructions}`;
  return `\n\n## Your space\nYou are part of the space "${space.name}", with other agents of the same person. You share its workspace and its group chat, and you deal only with them, with the person, and with Alia.${purpose}`;
}

/** How the notes are kept, said once under them. */
const NOTES_UPKEEP =
  'Keep these notes current with the `spaceNotes` tool so the others know what is decided, done and next: short, factual lines; detail in memory/<topic>.md.';

/**
 * The space's shared notes (its MEMORY.md) as labelled data, plus how to keep them. Pure. When there are
 * none yet it says so, so the first member to learn something knows where to put it.
 */
export function spaceNotesSection(index: string): string {
  const content = index.trim();
  if (content === '') {
    return `

## Notes of this space
The space's shared notes are empty. ${NOTES_UPKEEP}`;
  }
  const slice = agentMemoryPromptSlice(content);
  const body = `${slice.content}${slice.truncated ? '\n[…truncated; read the rest with the spaceNotes tool]' : ''}`;
  return `${memoryDataBlock('Notes of this space (shared by everyone in it)', body)}\n\n${NOTES_UPKEEP}`;
}

/**
 * The section for this agent, or '' when it is in no space (or its space has just been deleted): the
 * space and its brief, then its shared notes.
 */
export async function agentSpacePrompt(agent: { spaceId: string | null }): Promise<string> {
  if (!agent.spaceId) return '';
  const space = await findSpaceBrief(getDb(), agent.spaceId);
  if (!space) return '';
  const notes = await readSpaceNotes(getDb(), agent.spaceId, AGENT_MEMORY_INDEX).catch(
    () => undefined,
  );
  return `${spaceSection(space)}${spaceNotesSection(notes?.content ?? '')}`;
}
