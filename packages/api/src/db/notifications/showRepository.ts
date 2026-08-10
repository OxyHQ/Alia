/**
 * Generated audio shows, on Postgres.
 *
 * A show is created `queued`, driven through five statuses by
 * `lib/show/show-pipeline.ts`, and read back by the routes. `speakers` and
 * `segments` are `jsonb` arrays read and written whole — a segment's `speaker`
 * names a speaker WITHIN the same row, so a child table could not make that
 * reference checkable either.
 *
 * ## The pipeline's mutable document becomes a patch, and the local copy is the
 * caller's problem
 *
 * The Mongoose pipeline held ONE document for the whole run and called
 * `Object.assign(show, data); await show.save()`, so every later read of
 * `show.title` saw the accumulated state. There is no document here, so
 * `updateShow` takes a patch and returns the UPDATED ROW — the caller rebinds,
 * which keeps the accumulate-then-read behaviour explicit rather than implicit
 * in an object's identity.
 *
 * Returning the row rather than `void` is the load-bearing part: the pipeline
 * reads `show.title` after a patch that may have set it, and a `void` signature
 * would have left it reading a stale local.
 */

import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  ACTIVE_SHOW_STATUSES,
  shows,
  type ShowSegment,
  type ShowSpeaker,
  type ShowStatus,
  type ShowFormat,
} from '../schema/notifications';

/** A show row as stored. */
export type ShowRow = typeof shows.$inferSelect;

/** A show without its segments — the list projection. */
export type ShowListRow = Omit<ShowRow, 'segments'>;

export interface NewShow {
  readonly userId: string;
  readonly title: string;
  readonly topic: string;
  readonly format: ShowFormat;
  readonly sourceNotes?: string | undefined;
  readonly sourceConversationId?: string | undefined;
}

/** Fields the pipeline and the routes are allowed to patch. */
export interface ShowPatch {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: ShowStatus;
  readonly progress?: number;
  readonly error?: string | null;
  readonly speakers?: ShowSpeaker[];
  readonly segments?: ShowSegment[];
  readonly audioUrl?: string | null;
  readonly durationMs?: number | null;
  readonly creditsCharged?: number | null;
  readonly jobId?: string | null;
}

export async function createShow(db: ApiDatabase, input: NewShow): Promise<ShowRow> {
  const [row] = await db
    .insert(shows)
    .values({
      userId: input.userId,
      title: input.title,
      topic: input.topic,
      format: input.format,
      status: 'queued',
      progress: 0,
      sourceNotes: input.sourceNotes ?? null,
      sourceConversationId: input.sourceConversationId ?? null,
    })
    .returning();

  if (!row) throw new Error('show insert returned no row');
  return row;
}

/**
 * How many of this account's shows are still being produced.
 *
 * `count(*)::int` rather than reading `rows.length`: an aggregate comes back
 * from postgres.js as a STRING for `bigint`, which drizzle types as `number`, so
 * `total + 1` would concatenate. The cast makes the runtime value match the
 * type.
 */
export async function countActiveShows(db: ApiDatabase, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(shows)
    // `ACTIVE_SHOW_STATUSES` is imported rather than re-listed, so the cap counts
    // exactly the statuses the schema calls active and cannot drift from them.
    .where(and(eq(shows.userId, userId), inArray(shows.status, [...ACTIVE_SHOW_STATUSES])));

  return row?.n ?? 0;
}

/** Apply a patch and return the row as it now stands, or `null` if it is gone. */
export async function updateShow(
  db: ApiDatabase,
  showId: string,
  patch: ShowPatch,
): Promise<ShowRow | null> {
  // An empty `set` is a syntax error in Postgres, and a caller reaching here
  // with nothing to change wants the current row rather than a crash.
  if (Object.keys(patch).length === 0) return findShowById(db, showId);

  const [row] = await db.update(shows).set(patch).where(eq(shows.id, showId)).returning();
  return row ?? null;
}

/** Unscoped by design — the pipeline owns the id it was handed. */
export async function findShowById(db: ApiDatabase, showId: string): Promise<ShowRow | null> {
  const [row] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  return row ?? null;
}

/** Scoped, for the routes: a show id alone must not reveal another account's show. */
export async function findShowForUser(
  db: ApiDatabase,
  showId: string,
  userId: string,
): Promise<ShowRow | null> {
  const [row] = await db
    .select()
    .from(shows)
    .where(and(eq(shows.id, showId), eq(shows.userId, userId)))
    .limit(1);

  return row ?? null;
}

export interface ShowPage {
  readonly shows: ShowListRow[];
  readonly total: number;
}

/**
 * One page of a user's shows, newest first, WITHOUT segments.
 *
 * The exclusion is the point: `select('-segments')` kept a list response from
 * carrying every line of dialogue of every show. Listing the columns explicitly
 * rather than subtracting one means a column added later is absent until
 * somebody decides it belongs — the safe direction for a projection whose whole
 * purpose is to leave something out.
 */
export async function listShowsForUser(
  db: ApiDatabase,
  userId: string,
  limit: number,
  offset: number,
): Promise<ShowPage> {
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: shows.id,
        userId: shows.userId,
        title: shows.title,
        description: shows.description,
        topic: shows.topic,
        format: shows.format,
        status: shows.status,
        speakers: shows.speakers,
        audioUrl: shows.audioUrl,
        durationMs: shows.durationMs,
        error: shows.error,
        sourceConversationId: shows.sourceConversationId,
        sourceNotes: shows.sourceNotes,
        creditsCharged: shows.creditsCharged,
        progress: shows.progress,
        jobId: shows.jobId,
        createdAt: shows.createdAt,
        updatedAt: shows.updatedAt,
      })
      .from(shows)
      .where(eq(shows.userId, userId))
      .orderBy(desc(shows.createdAt), desc(shows.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(shows).where(eq(shows.userId, userId)),
  ]);

  return { shows: rows, total: totalRow?.n ?? 0 };
}

/**
 * Delete one of this account's shows, reporting whether it existed.
 *
 * `rowCount` answers "did it exist" exactly here — a DELETE matches or it does
 * not, so there is no matched-versus-modified distinction to get wrong. The
 * source returned the deleted document only to test it for null, which is the
 * same question.
 */
export async function deleteShowForUser(
  db: ApiDatabase,
  showId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .delete(shows)
    .where(and(eq(shows.id, showId), eq(shows.userId, userId)));

  return result.count > 0;
}
