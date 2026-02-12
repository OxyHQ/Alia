/**
 * User Context Builder
 *
 * Shared utility for building user context (name, memory, preferences, language)
 * from Oxy user data and UserMemory. Used by both chat-completions and voice realtime.
 */

import { oxyClient } from '../middleware/auth.js';
import { UserMemory } from '../models/user-memory.js';

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
    const user = await oxyClient.getUserById(userId) as any;
    userName = user?.name?.full || user?.name?.first || user?.username || null;
    if (userName) {
      contextString += `\nThe user's name is ${userName}.`;
    }
  } catch {}

  // Load user memory
  try {
    const userMemory = await UserMemory.findOne({ oxyUserId: userId });
    if (userMemory) {
      if (userMemory.memories?.length > 0) {
        contextString += '\n\n## Known Facts:\n' + userMemory.memories.map((m: any) => `- ${m.key}: ${m.value}`).join('\n');
      }
      if (userMemory.preferences && Object.keys(userMemory.preferences).length > 0) {
        const prefs = Object.entries(userMemory.preferences)
          .filter(([_, v]) => v !== undefined && v !== null)
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
    console.error('[UserContext] Error loading user memory:', e);
  }

  return { userName, language, contextString };
}
