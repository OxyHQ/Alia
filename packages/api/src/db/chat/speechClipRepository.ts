/**
 * The index of spoken clips (`db/schema/speech.ts`), on Postgres.
 *
 * Every read and every per-person delete is scoped to `oxy_user_id` in the
 * WHERE, although the key already hashes the person: a key is not a capability.
 * The retention sweep is the one statement that crosses people, and it selects
 * by age alone.
 *
 * Clocks are the SERVER's (`now()`), never a JavaScript `Date`: several tasks
 * write `last_used_at` and one compares against it.
 */

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import { speechClips } from '../schema/speech';

/** A stored clip, as the cache reads it. */
export interface SpeechClipRow {
  readonly cacheKey: string;
  readonly objectKey: string;
}

/** The clips this person holds under any of these keys. Order is the caller's to impose. */
export async function findSpeechClips(
  db: ApiDatabase,
  oxyUserId: string,
  cacheKeys: readonly string[],
): Promise<SpeechClipRow[]> {
  if (cacheKeys.length === 0) return [];
  return db
    .select({ cacheKey: speechClips.cacheKey, objectKey: speechClips.objectKey })
    .from(speechClips)
    .where(
      and(eq(speechClips.oxyUserId, oxyUserId), inArray(speechClips.cacheKey, [...cacheKeys])),
    );
}

/**
 * Record a hit: the clip was just used, and — when a saved message asked for it
 * and no conversation has claimed it yet — it now belongs to that conversation,
 * so deleting the conversation takes it.
 *
 * Only a clip with NO conversation is claimed. Moving one to the latest asker
 * would let deleting the FIRST conversation keep a clip spoken from it.
 */
export async function touchSpeechClip(
  db: ApiDatabase,
  oxyUserId: string,
  cacheKey: string,
  conversationId: string | null,
): Promise<void> {
  await db
    .update(speechClips)
    .set({
      lastUsedAt: sql`now()`,
      conversationId: sql`coalesce(${speechClips.conversationId}, ${conversationId})`,
    })
    .where(and(eq(speechClips.oxyUserId, oxyUserId), eq(speechClips.cacheKey, cacheKey)));
}

/**
 * Index a clip just stored, and answer the object key that now stands for it.
 *
 * One statement, so two tasks that made the same clip at once agree on ONE
 * object: the first insert wins, the second matches it and gets the winner's
 * key back — the caller compares and deletes its own surplus object. The
 * conflict branch only touches `last_used_at`, which is also what makes it
 * return the standing row.
 */
export async function indexSpeechClip(
  db: ApiDatabase,
  clip: {
    readonly cacheKey: string;
    readonly oxyUserId: string;
    readonly objectKey: string;
  },
): Promise<string> {
  const [standing] = await db
    .insert(speechClips)
    .values(clip)
    .onConflictDoUpdate({ target: speechClips.cacheKey, set: { lastUsedAt: sql`now()` } })
    .returning({ objectKey: speechClips.objectKey });
  if (standing === undefined) throw new Error('Speech clip was not indexed');
  return standing.objectKey;
}

/**
 * Remove every clip spoken from this person's conversation, answering the
 * object keys so the caller deletes the objects too — inside the same
 * transaction, so the rows come back if the objects could not go.
 */
export async function deleteConversationSpeechClips(
  db: Executor,
  oxyUserId: string,
  conversationId: string,
): Promise<string[]> {
  const removed = await db
    .delete(speechClips)
    .where(
      and(eq(speechClips.oxyUserId, oxyUserId), eq(speechClips.conversationId, conversationId)),
    )
    .returning({ objectKey: speechClips.objectKey });
  return removed.map((row) => row.objectKey);
}

/**
 * Remove up to `limit` clips nobody has used for `retentionDays`, answering
 * their object keys for the caller to delete in the same transaction.
 * `truncated` when the limit was reached and more may remain for the next run.
 */
export async function deleteStaleSpeechClips(
  db: Executor,
  retentionDays: number,
  limit: number,
): Promise<{ objectKeys: string[]; truncated: boolean }> {
  const stale = db
    .select({ cacheKey: speechClips.cacheKey })
    .from(speechClips)
    .where(lt(speechClips.lastUsedAt, sql`now() - make_interval(days => ${retentionDays})`))
    .limit(limit);
  const removed = await db
    .delete(speechClips)
    .where(
      and(
        inArray(speechClips.cacheKey, stale),
        // Again here, so a clip used between the pick and the delete is kept.
        lt(speechClips.lastUsedAt, sql`now() - make_interval(days => ${retentionDays})`),
      ),
    )
    .returning({ objectKey: speechClips.objectKey });
  return { objectKeys: removed.map((row) => row.objectKey), truncated: removed.length >= limit };
}
