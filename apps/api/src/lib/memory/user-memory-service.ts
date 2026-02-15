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
