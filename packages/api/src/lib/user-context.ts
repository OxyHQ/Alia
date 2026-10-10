/**
 * User Context Builder
 *
 * The `# USER CONTEXT` block a background prompt opens with (Alia's tasks,
 * `routes/internal.ts`). What Alia REMEMBERS is in it as labelled data
 * (`lib/memory/memory-prompt.ts`), never as bare lines a remembered sentence
 * could pose as an instruction in.
 *
 * `buildUserContext`, the fetching half that once lived here, had no caller
 * left and appended the person's memory unlabelled; it is gone rather than
 * fixed.
 */

import { memoryDataBlock, memoryFactLines } from './memory/memory-prompt.js';

/**
 * The `# USER CONTEXT` block a background prompt opens with, from data the
 * caller already has.
 *
 * ONE copy. There were two, in `lib/trigger-engine.ts` and `routes/internal.ts`,
 * both called `buildTriggerSystemPrompt` and with DIFFERENT signatures — four
 * arguments and three. Duplicated prompt logic with two spellings is the same
 * disease the five tool assemblers had, in miniature, and it had already
 * drifted: one said "The user's name is X" and the other "Name: X", one
 * carried the bio and the tone and the other did not.
 *
 * The task prompt each of them wraps is genuinely different — a scheduled
 * trigger is not a service event — so THAT stays with its caller. What is
 * shared is this, and only this.
 *
 * Takes fetched values rather than a `userId`: both callers already hold them,
 * and re-fetching inside a prompt builder would put an Oxy round trip on a path
 * that has one of its own.
 */
export function formatUserContextLines(
  oxyUser?: {
    name?: { full?: string; first?: string; middle?: string; last?: string };
    username?: string;
    location?: string;
    bio?: string;
  } | null,
  memory?: {
    preferences?: { language?: string; tone?: string };
    context?: { occupation?: string; location?: string };
    memories?: Array<{ title: string; summary: string }>;
  } | null,
): string[] {
  const lines: string[] = [];

  if (oxyUser) {
    const fullName =
      oxyUser.name?.full ||
      [oxyUser.name?.first, oxyUser.name?.middle, oxyUser.name?.last].filter(Boolean).join(' ');
    // `'User'` is Oxy's placeholder for an unnamed account, not a name.
    if (fullName && fullName !== 'User') lines.push(`The user's name is ${fullName}.`);
    if (oxyUser.username) lines.push(`The user's username is @${oxyUser.username}.`);
    if (oxyUser.location) lines.push(`The user is located in ${oxyUser.location}.`);
    if (oxyUser.bio) lines.push(`About the user: ${oxyUser.bio}`);
  }

  if (memory) {
    if (memory.preferences?.language) {
      lines.push(`User's preferred language: ${memory.preferences.language}.`);
    }
    const remembered: string[] = [];
    if (memory.context?.occupation) remembered.push(`- occupation: ${memory.context.occupation}`);
    if (memory.context?.location && !oxyUser?.location)
      remembered.push(`- location: ${memory.context.location}`);
    if (memory.preferences?.tone) remembered.push(`- preferred tone: ${memory.preferences.tone}`);
    if (memory.memories?.length) remembered.push(memoryFactLines(memory.memories));
    const block = memoryDataBlock('What you remember about the user', remembered.join('\n'));
    if (block !== '') lines.push(block.trimStart());
  }

  return lines;
}

/** The block itself, or nothing when there is nothing to say. */
export function userContextBlock(
  oxyUser?: Parameters<typeof formatUserContextLines>[0],
  memory?: Parameters<typeof formatUserContextLines>[1],
): string {
  const lines = formatUserContextLines(oxyUser, memory);
  return lines.length === 0 ? '' : `# USER CONTEXT\n\n${lines.join('\n')}\n\n---\n\n`;
}
