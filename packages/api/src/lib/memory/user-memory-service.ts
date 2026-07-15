/**
 * User Memory Service
 * Centralized find-or-create pattern for UserMemory documents.
 */

import { UserMemory, type IUserMemory } from '../../models/user-memory.js';

/**
 * Get an existing UserMemory document, or create an empty one if none exists.
 */
export async function getOrCreateUserMemory(oxyUserId: string): Promise<IUserMemory> {
  let memory = await UserMemory.findOne({ oxyUserId });
  if (!memory) {
    memory = new UserMemory({
      oxyUserId,
      memories: [],
      preferences: {},
      context: {},
    });
    await memory.save();
  }
  return memory;
}

/**
 * Resolve a user's preferred language from their UserMemory preferences.
 * Falls back to 'en-US' when the user is unknown or has no stored preference.
 */
export async function getUserLanguage(userId?: string): Promise<string> {
  if (!userId) return 'en-US';
  try {
    const memory = await UserMemory.findOne({ oxyUserId: userId })
      .select('preferences.language')
      .lean();
    return memory?.preferences?.language || 'en-US';
  } catch {
    return 'en-US';
  }
}
