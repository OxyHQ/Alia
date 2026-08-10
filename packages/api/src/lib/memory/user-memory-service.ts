/**
 * User Memory Service
 * Centralized find-or-create for a user's memory profile.
 *
 * The chokepoint nine files reach for. It stays a chokepoint after the port —
 * callers get a plain projection instead of a hydrated Mongoose document, so
 * `memory.memories[…]`, `memory.settings` and `memory.preferences` read exactly
 * as before, but there is no `save()`: a mutation is a named repository call.
 */

import { getDb } from '../../db/index.js';
import {
  findPreferredLanguage,
  getOrCreateUserMemory as getOrCreateProfile,
  type UserMemoryProfile,
} from '../../db/memory/userMemoryRepository.js';

export type { UserMemoryProfile };

/**
 * Get an existing memory profile, or create an empty one if none exists.
 */
export async function getOrCreateUserMemory(oxyUserId: string): Promise<UserMemoryProfile> {
  return getOrCreateProfile(getDb(), oxyUserId);
}

/**
 * Resolve a user's preferred language from their memory preferences.
 * Falls back to 'en-US' when the user is unknown or has no stored preference.
 *
 * Reads the one column rather than the profile and its entries: this is on the
 * chat hot path, and the Mongo version used `.select('preferences.language')`
 * for the same reason. The swallow is pre-existing and deliberate — a language
 * preference is decoration, and failing a chat turn over it would be worse than
 * answering in the default.
 */
export async function getUserLanguage(userId?: string): Promise<string> {
  if (!userId) return 'en-US';
  try {
    return (await findPreferredLanguage(getDb(), userId)) || 'en-US';
  } catch {
    return 'en-US';
  }
}
