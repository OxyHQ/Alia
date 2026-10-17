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

import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { recordFileReferences } from '../files/oxyFileRepository';
import type { ApiDatabase, Executor } from '../index';
import { speechClips } from '../schema/speech';

/** Where a clip's bytes are: a legacy object, an Oxy file Alia owns, or both while it moves. */
export interface StoredSpeechClip {
  readonly cacheKey: string;
  readonly objectKey: string | null;
  readonly oxyFileId: string | null;
}

/** A stored clip, as the cache reads it. */
export type SpeechClipRow = StoredSpeechClip;

const STORED = {
  cacheKey: speechClips.cacheKey,
  objectKey: speechClips.objectKey,
  oxyFileId: speechClips.oxyFileId,
} as const;

/** The clips this person holds under any of these keys. Order is the caller's to impose. */
export async function findSpeechClips(
  db: ApiDatabase,
  oxyUserId: string,
  cacheKeys: readonly string[],
): Promise<SpeechClipRow[]> {
  if (cacheKeys.length === 0) return [];
  return db
    .select(STORED)
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
 * Index a clip just stored, and answer where the clip that now stands is.
 *
 * One statement, so two tasks that made the same clip at once agree on ONE
 * stored copy: the first insert wins, the second matches it and gets the
 * winner's back — the caller compares and gives up its own surplus. The
 * conflict branch only touches `last_used_at`, which is also what makes it
 * return the standing row.
 *
 * The standing clip's Oxy file reference is recorded in the SAME transaction,
 * so Alia's use of the file exists exactly when the row does.
 */
export async function indexSpeechClip(
  db: ApiDatabase,
  clip: {
    readonly cacheKey: string;
    readonly oxyUserId: string;
    readonly objectKey: string | null;
    readonly oxyFileId?: string | null;
  },
): Promise<StoredSpeechClip> {
  return db.transaction(async (tx) => {
    const [standing] = await tx
      .insert(speechClips)
      .values({ ...clip, oxyFileId: clip.oxyFileId ?? null })
      .onConflictDoUpdate({ target: speechClips.cacheKey, set: { lastUsedAt: sql`now()` } })
      .returning(STORED);
    if (standing === undefined) throw new Error('Speech clip was not indexed');
    if (standing.oxyFileId !== null) {
      await recordFileReferences(tx, [
        {
          fileId: standing.oxyFileId,
          entityType: 'speech_clip',
          entityId: standing.cacheKey,
          desired: 'present',
        },
      ]);
    }
    return standing;
  });
}

/**
 * The migration's write: a legacy clip now also lives in an Oxy file Alia owns.
 * Only while it has none; the legacy key stays as the dual-read fallback.
 */
export async function adoptSpeechClipOxyFile(
  db: ApiDatabase,
  cacheKey: string,
  fileId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(speechClips)
      .set({ oxyFileId: fileId })
      .where(and(eq(speechClips.cacheKey, cacheKey), isNull(speechClips.oxyFileId)))
      .returning({ cacheKey: speechClips.cacheKey });
    if (!row) return false;
    await recordFileReferences(tx, [
      { fileId, entityType: 'speech_clip', entityId: cacheKey, desired: 'present' },
    ]);
    return true;
  });
}

/** Legacy clips with no Oxy copy yet, by key after `afterKey` — the migration's work list. */
export async function listSpeechClipsOnLegacyStorage(
  db: ApiDatabase,
  afterKey: string,
  limit: number,
): Promise<(StoredSpeechClip & { readonly oxyUserId: string })[]> {
  return db
    .select({ ...STORED, oxyUserId: speechClips.oxyUserId })
    .from(speechClips)
    .where(and(isNull(speechClips.oxyFileId), gt(speechClips.cacheKey, afterKey)))
    .orderBy(asc(speechClips.cacheKey))
    .limit(limit);
}

/** Clips whose Oxy file Oxy says is gone: the rows go too, legacy copy and all. */
export async function deleteSpeechClipsByOxyFile(
  db: Executor,
  fileId: string,
): Promise<StoredSpeechClip[]> {
  return db.delete(speechClips).where(eq(speechClips.oxyFileId, fileId)).returning(STORED);
}

/**
 * Remove every clip spoken from this person's conversation, answering where
 * each was stored so the caller releases them too — inside the same
 * transaction, so the rows come back if that could not be done.
 */
export async function deleteConversationSpeechClips(
  db: Executor,
  oxyUserId: string,
  conversationId: string,
): Promise<StoredSpeechClip[]> {
  return db
    .delete(speechClips)
    .where(
      and(eq(speechClips.oxyUserId, oxyUserId), eq(speechClips.conversationId, conversationId)),
    )
    .returning(STORED);
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
): Promise<{ clips: StoredSpeechClip[]; truncated: boolean }> {
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
    .returning(STORED);
  return { clips: removed, truncated: removed.length >= limit };
}
