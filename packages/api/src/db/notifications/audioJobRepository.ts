/**
 * Audio generation jobs, on Postgres.
 *
 * A job is ephemeral: the route creates one, answers `202` with its id, and a
 * background function drives it to `completed` or `failed` while the client
 * polls. Nothing reads a job after the URL it produced has been consumed, which
 * is why it carries the shortest retention in the schema (24 hours, registered
 * in `db/expiryTargets.ts`).
 *
 * ## `rowCount` IS the count the orphan sweep wants, and that is not automatic
 *
 * `cleanupOrphanedJobs` read Mongo's `modifiedCount` — the number of matched
 * documents the update actually CHANGED. Postgres reports only `rowCount`, which
 * behaves like `matchedCount`, so the two agree only when every matched row is
 * guaranteed to change.
 *
 * Here they do, and it is a property of the filter rather than a coincidence:
 * the update selects `status = 'processing'` and sets `status = 'failed'`, so a
 * matched row always changes. This is the narrowed-filter case in
 * `db/schema/CONVENTIONS.md`, not the `/health/reset-all` one where a matched
 * row can already hold the target value. `failOrphanedAudioJobs` is therefore a
 * faithful port of the count, and the realdb test pins it by calling the sweep
 * TWICE — a single call returns the same answer under either semantics, so only
 * the repeat can tell them apart.
 */

import { and, eq, lt } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { audioJobs } from '../schema/notifications';

/** A job is considered orphaned after this long in `processing`. */
const ORPHAN_AFTER_MS = 5 * 60 * 1000;

export interface NewAudioJob {
  readonly userId: string;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly conversationId?: string | undefined;
  readonly messageId?: string | undefined;
}

/**
 * Create a job in `processing` and return its id.
 *
 * The id is generated in the application by `generatedId()`, so it is known
 * without a second round trip — the route needs it for the `202` body it sends
 * before any work starts.
 */
export async function createAudioJob(db: ApiDatabase, input: NewAudioJob): Promise<string> {
  const [row] = await db
    .insert(audioJobs)
    .values({
      userId: input.userId,
      status: 'processing',
      prompt: input.prompt,
      durationSeconds: input.durationSeconds,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
    })
    .returning({ id: audioJobs.id });

  if (!row) throw new Error('audio job insert returned no row');
  return row.id;
}

/** Record a finished generation. Not scoped by user — the caller owns the id. */
export async function markAudioJobCompleted(
  db: ApiDatabase,
  jobId: string,
  audioUrl: string,
): Promise<void> {
  await db
    .update(audioJobs)
    .set({ status: 'completed', audioUrl })
    .where(eq(audioJobs.id, jobId));
}

/** Record a failed generation. Not scoped by user — the caller owns the id. */
export async function markAudioJobFailed(
  db: ApiDatabase,
  jobId: string,
  error: string,
): Promise<void> {
  await db.update(audioJobs).set({ status: 'failed', error }).where(eq(audioJobs.id, jobId));
}

export interface AudioJobStatusRow {
  readonly status: string;
  readonly audioUrl: string | null;
  readonly error: string | null;
}

/**
 * The three fields the polling route renders, for a job belonging to this user.
 *
 * Scoped by `userId` exactly as the source was: a job id alone must not reveal
 * another account's generation. `id` is `text`, so an id of any shape simply
 * fails to match rather than raising — where Mongo answered a malformed
 * `ObjectId` with a `CastError` the route turned into a 500, this returns the
 * 404 the caller deserved.
 */
export async function findAudioJobStatus(
  db: ApiDatabase,
  jobId: string,
  userId: string,
): Promise<AudioJobStatusRow | null> {
  const [row] = await db
    .select({ status: audioJobs.status, audioUrl: audioJobs.audioUrl, error: audioJobs.error })
    .from(audioJobs)
    .where(and(eq(audioJobs.id, jobId), eq(audioJobs.userId, userId)))
    .limit(1);

  return row ?? null;
}

/**
 * Fail every job left in `processing` by a crashed process, returning how many.
 *
 * `now` is a parameter so a test can place the cutoff without sleeping; the
 * caller passes nothing.
 */
export async function failOrphanedAudioJobs(
  db: ApiDatabase,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ORPHAN_AFTER_MS);
  const result = await db
    .update(audioJobs)
    .set({ status: 'failed', error: 'Job orphaned — server restarted during generation' })
    .where(and(eq(audioJobs.status, 'processing'), lt(audioJobs.createdAt, cutoff)));

  // `count`, never `rows.length` — an UPDATE returns no rows without a
  // `RETURNING`, so `rows.length` is 0 whether one row changed or a thousand.
  return result.count;
}
