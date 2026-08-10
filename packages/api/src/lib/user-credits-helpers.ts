/**
 * Shared helper for getting or creating a UserCredits record.
 *
 * The default free-credit values live in `db/billing/userCreditsRepository.ts`
 * with the statement that applies them, so the upsert and its defaults cannot
 * drift apart.
 *
 * **The returned value is a ROW, not a Mongoose document.** It has no
 * `addCredits`, no `refreshCreditsIfNeeded` and no `save()`: each of those was a
 * database write wearing a method's clothes, and each is now a named function in
 * the repository. Callers reading `credits.free` read `creditsFree`.
 */

import { getDb } from '../db/index.js';
import {
  getOrCreateUserCredits as getOrCreate,
  refreshFreeCreditsIfDue,
  type UserCreditsRow,
} from '../db/billing/userCreditsRepository.js';

export async function getOrCreateUserCredits(userId: string): Promise<UserCreditsRow> {
  return getOrCreate(getDb(), userId);
}

/**
 * The balance row with today's free allowance applied — what every surface that
 * DISPLAYS a balance wants.
 *
 * The source did this in two steps at five call sites: `getOrCreateUserCredits`
 * followed by `userCredits.refreshCreditsIfNeeded()`, a document method that
 * mutated the in-memory document AND wrote to the database. With the document
 * gone the second step has to return the fresh row rather than mutate one, so
 * the pair is expressed once here instead of five times.
 *
 * `refreshFreeCreditsIfDue` cannot answer null immediately after the upsert
 * unless the row was deleted concurrently, which is not a state any caller can
 * do anything about — so it throws rather than handing back a balance of zero.
 */
export async function getRefreshedUserCredits(userId: string): Promise<UserCreditsRow> {
  const db = getDb();
  await getOrCreate(db, userId);
  const row = await refreshFreeCreditsIfDue(db, userId);
  if (!row) throw new Error(`user credits vanished during refresh: ${userId}`);
  return row;
}
