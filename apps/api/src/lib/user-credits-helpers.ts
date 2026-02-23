/**
 * Shared helper for getting or creating a UserCredits record.
 * Centralizes the default free credit values in one place.
 */

import { UserCredits } from '../models/user-credits.js';

const DEFAULT_FREE_CREDITS = 300;

export async function getOrCreateUserCredits(userId: string) {
  return UserCredits.findByIdAndUpdate(
    userId,
    {
      $setOnInsert: {
        _id: userId,
        credits: {
          free: DEFAULT_FREE_CREDITS,
          freeLimit: DEFAULT_FREE_CREDITS,
          dailyRefresh: DEFAULT_FREE_CREDITS,
          lastRefresh: new Date(),
          paid: 0,
        },
      },
    },
    { upsert: true, returnDocument: 'after' }
  );
}
