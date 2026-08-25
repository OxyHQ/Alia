/**
 * Show series and their episodes, on Postgres.
 *
 * ## Two read shapes, and the difference is a credential
 *
 * `show_episodes.ingest_ticket` is a bearer capability that lets a process with
 * no user session attach audio to somebody's podcast. So this module offers two
 * ways to read an episode and they are not interchangeable:
 *
 *  - {@link findEpisodeById} selects the WHOLE row, ticket included. It is for
 *    the pipeline, which is the one caller that has to redeem one.
 *  - Everything a route can reach goes through {@link EPISODE_PUBLIC_COLUMNS},
 *    which names its columns and leaves the ticket out.
 *
 * Written as an explicit column list rather than as a `delete` on the way past:
 * a projection that SUBTRACTS is a projection that carries every column added
 * later, and the one column this must never emit is a credential. The
 * `provider_keys.key` rule, applied to a table that did not exist when it was
 * written.
 *
 * ## The pipeline's mutable document is a patch, and the local copy is the
 * caller's problem
 *
 * `updateEpisode` takes a patch and returns the UPDATED ROW, so the pipeline can
 * rebind and keep reading accumulated state. A `void` signature would leave it
 * reading a stale local, which is the bug the shape exists to prevent.
 */

import { and, count, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  ACTIVE_SHOW_EPISODE_STATUSES,
  showEpisodes,
  showPreferences,
  showSeries,
  type ShowEpisodeStatus,
  type ShowFormat,
  type ShowSegment,
  type ShowSpeaker,
  type ShowVisibility,
} from '../schema/shows';

/** A series row as stored. */
export type ShowSeriesRow = typeof showSeries.$inferSelect;
/** An episode row as stored, INCLUDING its ingest ticket. */
export type ShowEpisodeRow = typeof showEpisodes.$inferSelect;
/** An episode as a route may see it — no ingest ticket. */
export type ShowEpisodePublicRow = Omit<
  ShowEpisodeRow,
  'ingestTicket' | 'ingestTicketExpiresAt'
>;
/** One account's defaults. */
export type ShowPreferencesRow = typeof showPreferences.$inferSelect;

/**
 * Every episode column a route may return.
 *
 * `ingestTicket` and `ingestTicketExpiresAt` are absent, and that absence is the
 * point — see the module comment. Adding a column here is a deliberate act;
 * adding one to the table is not enough to expose it.
 */
const EPISODE_PUBLIC_COLUMNS = {
  id: showEpisodes.id,
  userId: showEpisodes.userId,
  seriesId: showEpisodes.seriesId,
  episodeNumber: showEpisodes.episodeNumber,
  title: showEpisodes.title,
  topic: showEpisodes.topic,
  notes: showEpisodes.notes,
  status: showEpisodes.status,
  progress: showEpisodes.progress,
  segments: showEpisodes.segments,
  error: showEpisodes.error,
  jobId: showEpisodes.jobId,
  creditsCharged: showEpisodes.creditsCharged,
  syraEpisodeId: showEpisodes.syraEpisodeId,
  recap: showEpisodes.recap,
  durationMs: showEpisodes.durationMs,
  sourceConversationId: showEpisodes.sourceConversationId,
  createdAt: showEpisodes.createdAt,
  updatedAt: showEpisodes.updatedAt,
} as const;

// ── Series ───────────────────────────────────────────────────────────────────

export interface NewShowSeries {
  /**
   * Minted by the CALLER, not by the column's default.
   *
   * Syra records this id as the show's provenance, so its podcast must be
   * created with it — and `syra_podcast_id` is NOT NULL, so the podcast must
   * exist before this row. The id therefore has to be known before either, which
   * a `generatedId()` default cannot manage: it produces a value only as a side
   * effect of the insert that needs the podcast that needs the id.
   */
  readonly id: string;
  readonly userId: string;
  readonly syraPodcastId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly format: ShowFormat;
  readonly brief: string;
  readonly speakers: ShowSpeaker[];
  readonly visibility: ShowVisibility;
  readonly coverImageAssetId?: string | undefined;
}

export async function createSeries(
  db: ApiDatabase,
  input: NewShowSeries,
): Promise<ShowSeriesRow> {
  const [row] = await db
    .insert(showSeries)
    .values({
      id: input.id,
      userId: input.userId,
      syraPodcastId: input.syraPodcastId,
      title: input.title,
      description: input.description ?? null,
      format: input.format,
      brief: input.brief,
      speakers: input.speakers,
      visibility: input.visibility,
      coverImageAssetId: input.coverImageAssetId ?? null,
    })
    .returning();

  if (!row) throw new Error('show series insert returned no row');
  return row;
}

/** What the owner may change about a series after it exists. */
export interface ShowSeriesPatch {
  readonly title?: string;
  readonly description?: string | null;
  readonly brief?: string;
  readonly visibility?: ShowVisibility;
  readonly coverImageAssetId?: string | null;
  readonly speakers?: ShowSpeaker[];
}

/**
 * Apply a patch to one of this account's series.
 *
 * Scoped by `userId` in the statement rather than after a read: a series id
 * alone must not let one account edit another's show, and doing it in the WHERE
 * clause means there is no window between the check and the write.
 */
export async function updateSeriesForUser(
  db: ApiDatabase,
  seriesId: string,
  userId: string,
  patch: ShowSeriesPatch,
): Promise<ShowSeriesRow | null> {
  // An empty `set` is a syntax error in Postgres, and a caller reaching here
  // with nothing to change wants the current row rather than a crash.
  if (Object.keys(patch).length === 0) return findSeriesForUser(db, seriesId, userId);

  const [row] = await db
    .update(showSeries)
    .set(patch)
    .where(and(eq(showSeries.id, seriesId), eq(showSeries.userId, userId)))
    .returning();

  return row ?? null;
}

/** Unscoped by design — the pipeline owns the id it was handed. */
export async function findSeriesById(
  db: ApiDatabase,
  seriesId: string,
): Promise<ShowSeriesRow | null> {
  const [row] = await db.select().from(showSeries).where(eq(showSeries.id, seriesId)).limit(1);
  return row ?? null;
}

/** Scoped, for the routes. */
export async function findSeriesForUser(
  db: ApiDatabase,
  seriesId: string,
  userId: string,
): Promise<ShowSeriesRow | null> {
  const [row] = await db
    .select()
    .from(showSeries)
    .where(and(eq(showSeries.id, seriesId), eq(showSeries.userId, userId)))
    .limit(1);

  return row ?? null;
}

export interface ShowSeriesPage {
  readonly series: ShowSeriesRow[];
  readonly total: number;
}

/**
 * One page of a user's series, newest first.
 *
 * `createdAt` with `id` only as a tiebreaker: a uuid v7 is monotonic to the
 * millisecond and this schema mints no per-process counter, so two series
 * created in the same millisecond order arbitrarily by id alone. The pair is a
 * total order, which is what keeps a page boundary from repeating or skipping a
 * row.
 */
export async function listSeriesForUser(
  db: ApiDatabase,
  userId: string,
  limit: number,
  offset: number,
): Promise<ShowSeriesPage> {
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(showSeries)
      .where(eq(showSeries.userId, userId))
      .orderBy(desc(showSeries.createdAt), desc(showSeries.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(showSeries).where(eq(showSeries.userId, userId)),
  ]);

  return { series: rows, total: totalRow?.n ?? 0 };
}

/**
 * Delete one of this account's series. Its episodes go with it, by the foreign
 * key's `ON DELETE CASCADE` rather than by a second statement here.
 *
 * This removes ALIA's record. The Syra podcast is a separate resource with its
 * own owner and its own listeners, and it is not deleted from here — the caller
 * decides that, holding the user's own credential.
 */
export async function deleteSeriesForUser(
  db: ApiDatabase,
  seriesId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .delete(showSeries)
    .where(and(eq(showSeries.id, seriesId), eq(showSeries.userId, userId)));

  return result.count > 0;
}

/**
 * Take the next episode number for a series, atomically.
 *
 * `UPDATE … SET n = n + 1 RETURNING n` in ONE statement, so two concurrent
 * requests cannot both be handed the same number — a read-then-write would let
 * exactly that happen, and the unique index on `(series_id, episode_number)`
 * would then turn the loser into a 500 rather than into a second episode.
 * RETURNING reports the value AFTER the increment, so the number allocated to
 * this caller is one less.
 *
 * `null` means no such series for this account, which is the same answer an
 * ownership check would give and needs no separate read to produce.
 */
export async function allocateEpisodeNumber(
  db: ApiDatabase,
  seriesId: string,
  userId: string,
): Promise<number | null> {
  const [row] = await db
    .update(showSeries)
    .set({ nextEpisodeNumber: sql`${showSeries.nextEpisodeNumber} + 1` })
    .where(and(eq(showSeries.id, seriesId), eq(showSeries.userId, userId)))
    .returning({ next: showSeries.nextEpisodeNumber });

  return row === undefined ? null : row.next - 1;
}

// ── Episodes ─────────────────────────────────────────────────────────────────

export interface NewShowEpisode {
  readonly userId: string;
  readonly seriesId: string;
  readonly episodeNumber: number;
  /** Absent when nobody named this episode — the script names it from what it says. */
  readonly title?: string | undefined;
  /** Absent when nobody said what this episode covers — the script decides it. */
  readonly topic?: string | undefined;
  readonly notes?: string | undefined;
  readonly syraEpisodeId: string;
  readonly ingestTicket: string;
  readonly ingestTicketExpiresAt: Date;
  readonly sourceConversationId?: string | undefined;
}

export async function createEpisode(
  db: ApiDatabase,
  input: NewShowEpisode,
): Promise<ShowEpisodeRow> {
  const [row] = await db
    .insert(showEpisodes)
    .values({
      userId: input.userId,
      seriesId: input.seriesId,
      episodeNumber: input.episodeNumber,
      title: input.title ?? null,
      topic: input.topic ?? null,
      notes: input.notes ?? null,
      syraEpisodeId: input.syraEpisodeId,
      ingestTicket: input.ingestTicket,
      ingestTicketExpiresAt: input.ingestTicketExpiresAt,
      sourceConversationId: input.sourceConversationId ?? null,
    })
    .returning();

  if (!row) throw new Error('show episode insert returned no row');
  return row;
}

/** Fields the pipeline is allowed to patch. `seriesId` and `userId` are not among them. */
export interface ShowEpisodePatch {
  /**
   * The name, once something has settled on one.
   *
   * Patchable because a title is now read off the finished episode rather than
   * guessed from a request, and the same string is what the ingest sends to
   * Syra — so this write and that call have to agree by construction. The
   * pipeline writes it only when the row had none: a name the owner chose is
   * not the pipeline's to revise.
   */
  readonly title?: string;
  /** The subject the script settled on, when the request named none. */
  readonly topic?: string | null;
  readonly status?: ShowEpisodeStatus;
  readonly progress?: number;
  readonly error?: string | null;
  readonly segments?: ShowSegment[];
  readonly creditsCharged?: number | null;
  readonly jobId?: string | null;
  readonly recap?: string | null;
  readonly durationMs?: number | null;
  /** Set to `null` once redeemed — a spent capability is not worth storing. */
  readonly ingestTicket?: string | null;
}

/** Apply a patch and return the row as it now stands, or `null` if it is gone. */
export async function updateEpisode(
  db: ApiDatabase,
  episodeId: string,
  patch: ShowEpisodePatch,
): Promise<ShowEpisodeRow | null> {
  if (Object.keys(patch).length === 0) return findEpisodeById(db, episodeId);

  const [row] = await db
    .update(showEpisodes)
    .set(patch)
    .where(eq(showEpisodes.id, episodeId))
    .returning();

  return row ?? null;
}

/**
 * The WHOLE row, ingest ticket included. For the pipeline only.
 *
 * Unscoped by design — the pipeline owns the id it was handed, exactly as it
 * owns the job it was enqueued with.
 */
export async function findEpisodeById(
  db: ApiDatabase,
  episodeId: string,
): Promise<ShowEpisodeRow | null> {
  const [row] = await db
    .select()
    .from(showEpisodes)
    .where(eq(showEpisodes.id, episodeId))
    .limit(1);

  return row ?? null;
}

/** Scoped and ticket-free, for the routes. */
export async function findEpisodeForUser(
  db: ApiDatabase,
  episodeId: string,
  userId: string,
): Promise<ShowEpisodePublicRow | null> {
  const [row] = await db
    .select(EPISODE_PUBLIC_COLUMNS)
    .from(showEpisodes)
    .where(and(eq(showEpisodes.id, episodeId), eq(showEpisodes.userId, userId)))
    .limit(1);

  return row ?? null;
}

export interface ShowEpisodePage {
  readonly episodes: ShowEpisodePublicRow[];
  readonly total: number;
}

/**
 * One series' episodes, highest number first, without ingest tickets.
 *
 * Ordered by `episodeNumber` rather than by `createdAt`, because that is the
 * order a listener thinks in and the two can disagree: an episode that failed
 * and was regenerated keeps its number while taking a later timestamp.
 */
export async function listEpisodesForSeries(
  db: ApiDatabase,
  seriesId: string,
  limit: number,
  offset: number,
): Promise<ShowEpisodePage> {
  const [rows, [totalRow]] = await Promise.all([
    db
      .select(EPISODE_PUBLIC_COLUMNS)
      .from(showEpisodes)
      .where(eq(showEpisodes.seriesId, seriesId))
      .orderBy(desc(showEpisodes.episodeNumber))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(showEpisodes).where(eq(showEpisodes.seriesId, seriesId)),
  ]);

  return { episodes: rows, total: totalRow?.n ?? 0 };
}

/**
 * How many of this account's episodes are still being produced.
 *
 * `count(*)::int` rather than `rows.length`: an aggregate comes back from
 * postgres.js as a STRING for `bigint`, which drizzle types as `number`, so
 * `total + 1` would concatenate. The cast makes the runtime value match the
 * type.
 *
 * `ACTIVE_SHOW_EPISODE_STATUSES` is imported rather than re-listed, so the cap
 * counts exactly the statuses the schema calls active and cannot drift from
 * them.
 */
export async function countActiveEpisodes(db: ApiDatabase, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(showEpisodes)
    .where(
      and(
        eq(showEpisodes.userId, userId),
        inArray(showEpisodes.status, [...ACTIVE_SHOW_EPISODE_STATUSES]),
      ),
    );

  return row?.n ?? 0;
}

export async function deleteEpisodeForUser(
  db: ApiDatabase,
  episodeId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .delete(showEpisodes)
    .where(and(eq(showEpisodes.id, episodeId), eq(showEpisodes.userId, userId)));

  return result.count > 0;
}

/**
 * What the episodes BEFORE this one were about, oldest first.
 *
 * This is the series' memory, and it is deliberately two things at two costs.
 * `topic` is one line per episode, so every episode in the window can be listed
 * and the script can be told not to cover any of them again; `recap` is several
 * sentences, so only the most recent few are ever sent. A window of recaps
 * alone is what lets a show repeat itself at episode nine — from the model's
 * side, everything older than the window never happened.
 *
 * Selected by `episodeNumber < before` rather than by timestamp, because a
 * regenerated episode 3 is still episode 3 however late its row was written —
 * ordering by time would hand episode 4 a "previously on" that skipped it.
 * Returned OLDEST first so a prompt reads them in the order a listener heard
 * them, which is the reverse of how they are fetched.
 *
 * `failed` episodes are EXCLUDED, and that is the difference between a subject
 * that was covered and one that was merely attempted: an episode whose run died
 * said nothing to a listener, so holding its subject out of every future episode
 * would retire a subject the show never actually did. Every other status is
 * included, in-flight ones especially — an episode still being recorded has
 * already claimed its subject, and leaving it out is how two episodes queued a
 * minute apart end up covering the same thing.
 *
 * `limit` bounds the newest end. A show longer than the limit may revisit
 * something from beyond it, which is the honest trade: the alternative is a
 * prompt that grows without bound.
 */
export interface PriorEpisode {
  readonly episodeNumber: number;
  /** `null` while a queued episode's script has not chosen one yet. */
  readonly topic: string | null;
  /** `null` until the episode is produced. */
  readonly recap: string | null;
}

export async function priorEpisodes(
  db: ApiDatabase,
  seriesId: string,
  beforeEpisodeNumber: number,
  limit: number,
): Promise<PriorEpisode[]> {
  const rows = await db
    .select({
      episodeNumber: showEpisodes.episodeNumber,
      topic: showEpisodes.topic,
      recap: showEpisodes.recap,
    })
    .from(showEpisodes)
    .where(
      and(
        eq(showEpisodes.seriesId, seriesId),
        lt(showEpisodes.episodeNumber, beforeEpisodeNumber),
        ne(showEpisodes.status, 'failed'),
      ),
    )
    .orderBy(desc(showEpisodes.episodeNumber))
    .limit(limit);

  return rows.sort((a, b) => a.episodeNumber - b.episodeNumber);
}

// ── Preferences ──────────────────────────────────────────────────────────────

/**
 * One account's defaults, or `null` when they have never set any.
 *
 * `null` is not an error and not an empty object: nothing writes a row until
 * somebody changes something, so the caller applies the schema's own defaults
 * rather than treating absence as a fault.
 */
export async function findPreferences(
  db: ApiDatabase,
  userId: string,
): Promise<ShowPreferencesRow | null> {
  const [row] = await db
    .select()
    .from(showPreferences)
    .where(eq(showPreferences.userId, userId))
    .limit(1);

  return row ?? null;
}

export interface ShowPreferencesInput {
  readonly defaultVisibility: ShowVisibility;
  readonly defaultFormat: ShowFormat;
}

/**
 * Store this account's defaults, creating the row if it is the first time.
 *
 * `updatedAt` is deliberately absent from the `set`. It looks like it has to be
 * there, because the column's default applies on INSERT only — but `@oxyhq/db`'s
 * `updatedAt()` carries `$onUpdate` and drizzle applies that to an
 * `onConflictDoUpdate` set as well as to `db.update()`, measured in
 * `memoryEmbeddingRepository.ts` by compiling both forms. Writing it anyway
 * swaps the builder's clock for this process's, so the two disagree under skew.
 */
export async function upsertPreferences(
  db: ApiDatabase,
  userId: string,
  input: ShowPreferencesInput,
): Promise<ShowPreferencesRow> {
  const [row] = await db
    .insert(showPreferences)
    .values({
      userId,
      defaultVisibility: input.defaultVisibility,
      defaultFormat: input.defaultFormat,
    })
    .onConflictDoUpdate({
      target: showPreferences.userId,
      set: {
        defaultVisibility: input.defaultVisibility,
        defaultFormat: input.defaultFormat,
      },
    })
    .returning();

  if (!row) throw new Error('show preferences upsert returned no row');
  return row;
}
