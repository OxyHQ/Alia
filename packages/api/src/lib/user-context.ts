/**
 * User Context Builder
 *
 * Shared utility for building user context (name, memory, preferences, language)
 * from Oxy user data and UserMemory. Used by both chat-completions and voice realtime.
 */

import { oxyClient } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { findUserMemory } from '../db/memory/userMemoryRepository.js';
import { log } from './logger.js';

export interface UserContext {
  userName: string | null;
  language: string | null;
  contextString: string;
}

/**
 * Build user context string from Oxy profile and UserMemory.
 * Returns the user's name, language preference, and a combined context string
 * containing known facts, preferences, and context.
 */
export async function buildUserContext(userId: string): Promise<UserContext> {
  let userName: string | null = null;
  let language: string | null = null;
  let contextString = '';

  // Fetch user name from Oxy
  try {
    const user = await oxyClient.getUserById(userId);
    userName = user?.name?.full || user?.name?.first || user?.username || null;
    if (userName) {
      contextString += `\nThe user's name is ${userName}.`;
    }
  } catch { /* user lookup optional */ }

  // Load user memory
  try {
    const userMemory = await findUserMemory(getDb(), userId);
    if (userMemory) {
      if (userMemory.memories.length > 0) {
        contextString += '\n\n## Known Facts:\n' + userMemory.memories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
      }
      if (userMemory.preferences && Object.keys(userMemory.preferences).length > 0) {
        const prefs = Object.entries(userMemory.preferences)
          .filter(([k, v]) => v !== undefined && v !== null && k !== 'language')
          .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        if (prefs.length > 0) {
          contextString += '\n\n## Preferences:\n' + prefs.join('\n');
        }
      }
      if (userMemory.context && Object.keys(userMemory.context).length > 0) {
        const ctx = Object.entries(userMemory.context)
          .filter(([_, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `- ${k}: ${v}`);
        if (ctx.length > 0) {
          contextString += '\n\n## Context:\n' + ctx.join('\n');
        }
      }
      language = userMemory.preferences?.language || null;
    }
  } catch (e) {
    log.memory.error({ err: e }, 'Error loading user memory');
  }

  return { userName, language, contextString };
}

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
 * that has one of its own. That is what separates this from
 * {@link buildUserContext} above, which is the fetching half.
 */
export function formatUserContextLines(
  oxyUser?: { name?: { full?: string; first?: string; middle?: string; last?: string }; username?: string; location?: string; bio?: string } | null,
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
    if (memory.context?.occupation) lines.push(`The user works as a ${memory.context.occupation}.`);
    if (memory.context?.location && !oxyUser?.location) {
      lines.push(`The user is located in ${memory.context.location}.`);
    }
    if (memory.preferences?.tone) lines.push(`The user prefers a ${memory.preferences.tone} tone.`);
    if (memory.memories?.length) {
      const items = memory.memories.map((m) => `- ${m.title}: ${m.summary}`).join('\n');
      lines.push(`\nThings to remember about the user:\n${items}`);
    }
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
