import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { EXPIRY_TARGETS } from '../expiryTargets';
import { audioJobs } from '../schema/notifications';
import {
  createAudioJob,
  failOrphanedAudioJobs,
  findAudioJobStatus,
  markAudioJobCompleted,
  markAudioJobFailed,
} from '../notifications/audioJobRepository';

/**
 * Audio jobs, against a REAL server.
 *
 * ## This file OWNS `audio_jobs`, and that is load-bearing
 *
 * `failOrphanedAudioJobs` is deliberately UNSCOPED — it fails every stalled job
 * in the table, as the Mongoose static did, because a crashed process leaves
 * orphans belonging to whoever happened to be generating. That makes its
 * returned count a property of the whole table, and realdb files share ONE
 * database per run: a sibling file inserting a `processing` row older than five
 * minutes would silently join the count and turn an exact assertion into a flaky
 * one, in the direction that reads as a real failure.
 *
 * So every test touching `audio_jobs` lives here, including the 24-hour expiry
 * sweep that used to sit in `notifications.pgdb.test.ts`. Vitest runs a file's
 * tests sequentially, so single ownership is what makes the counts exact
 * without an advisory lock. If a second file ever needs this table, the counts
 * here stop being trustworthy — move it here instead.
 *
 * Fixture instants are written RELATIVE to `now` for the other half of the same
 * problem: a full-registry sweep run by any file reaps by absolute deadline, and
 * a hardcoded date is a time bomb that detonates in whichever file next changes
 * an import.
 */

let db: ApiDatabase;

const USER = 'oxy-audio-repo';
const OTHER_USER = 'oxy-audio-repo-other';

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  // This file owns the table, so a clean slate between tests is safe and is what
  // lets the sweep counts be asserted exactly rather than as a floor.
  await db.delete(audioJobs);
});

/** Insert a job with an explicit age, bypassing the repository's `now`. */
async function seedJob(fields: {
  id: string;
  userId: string;
  status?: 'processing' | 'completed' | 'failed';
  ageMs: number;
  error?: string;
}): Promise<void> {
  await db.insert(audioJobs).values({
    id: fields.id,
    userId: fields.userId,
    status: fields.status ?? 'processing',
    prompt: 'p',
    durationSeconds: 10,
    error: fields.error ?? null,
    // A `Date` through the query BUILDER is fine; it is a bare `Date` bound
    // through a raw `sql` template that dies in the driver.
    createdAt: new Date(Date.now() - fields.ageMs),
  });
}

describe('creating a job', () => {
  it('returns the id the route answers 202 with, without a second read', async () => {
    const id = await createAudioJob(db, {
      userId: USER,
      prompt: 'a calm piano loop',
      durationSeconds: 30,
      conversationId: 'conv-1',
      messageId: 'msg-1',
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await db.select().from(audioJobs).where(eq(audioJobs.id, id));
    expect(row).toMatchObject({
      userId: USER,
      status: 'processing',
      prompt: 'a calm piano loop',
      durationSeconds: 30,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      audioUrl: null,
      error: null,
    });
  });

  it('leaves the optional links null rather than inventing them', async () => {
    const id = await createAudioJob(db, { userId: USER, prompt: 'p', durationSeconds: 5 });
    const [row] = await db.select().from(audioJobs).where(eq(audioJobs.id, id));
    expect(row?.conversationId).toBeNull();
    expect(row?.messageId).toBeNull();
  });
});

describe('driving a job to a terminal state', () => {
  it('records the URL on completion', async () => {
    const id = await createAudioJob(db, { userId: USER, prompt: 'p', durationSeconds: 5 });
    await markAudioJobCompleted(db, id, 'https://cdn.example/audio.mp3');

    const status = await findAudioJobStatus(db, id, USER);
    expect(status).toEqual({
      status: 'completed',
      audioUrl: 'https://cdn.example/audio.mp3',
      error: null,
    });
  });

  it('records the reason on failure', async () => {
    const id = await createAudioJob(db, { userId: USER, prompt: 'p', durationSeconds: 5 });
    await markAudioJobFailed(db, id, 'Generation returned no audio');

    const status = await findAudioJobStatus(db, id, USER);
    expect(status).toEqual({
      status: 'failed',
      audioUrl: null,
      error: 'Generation returned no audio',
    });
  });
});

describe('polling is scoped to the account that owns the job', () => {
  it('does not return another account job under a guessed id', async () => {
    const id = await createAudioJob(db, { userId: OTHER_USER, prompt: 'p', durationSeconds: 5 });

    // The row exists; asking as the wrong user must answer as if it did not.
    expect(await findAudioJobStatus(db, id, OTHER_USER)).not.toBeNull();
    expect(await findAudioJobStatus(db, id, USER)).toBeNull();
  });

  it('answers a malformed id with a miss rather than raising', async () => {
    /**
     * Under Mongo `_id` was an `ObjectId`, so a junk `jobId` threw a `CastError`
     * that the route turned into a 500. `id` is `text` here, so it simply fails
     * to match — the caller gets the 404 it deserved. A behaviour change, in the
     * direction of the status code the route always meant.
     */
    await expect(findAudioJobStatus(db, 'not-an-id-at-all', USER)).resolves.toBeNull();
  });
});

describe('the orphan sweep', () => {
  it('fails only jobs still processing past the cutoff', async () => {
    await seedJob({ id: 'aj-old', userId: USER, ageMs: 6 * 60_000 });
    await seedJob({ id: 'aj-old-2', userId: OTHER_USER, ageMs: 60 * 60_000 });
    await seedJob({ id: 'aj-fresh', userId: USER, ageMs: 60_000 });
    await seedJob({ id: 'aj-done', userId: USER, status: 'completed', ageMs: 6 * 60_000 });

    const failed = await failOrphanedAudioJobs(db);
    expect(failed).toBe(2);

    const rows = await db
      .select({ id: audioJobs.id, status: audioJobs.status, error: audioJobs.error })
      .from(audioJobs)
      .orderBy(audioJobs.id);

    expect(rows).toEqual([
      { id: 'aj-done', status: 'completed', error: null },
      { id: 'aj-fresh', status: 'processing', error: null },
      {
        id: 'aj-old',
        status: 'failed',
        error: 'Job orphaned — server restarted during generation',
      },
      {
        id: 'aj-old-2',
        status: 'failed',
        error: 'Job orphaned — server restarted during generation',
      },
    ]);
  });

  it('is not a `matchedCount` in disguise — the REPEAT is the discriminator', async () => {
    /**
     * Mongo reported `modifiedCount`; Postgres reports only `rowCount`, which
     * behaves like `matchedCount`. A SINGLE call returns the same answer under
     * either meaning, so it cannot tell them apart — only a repeat can.
     *
     * They agree here because the filter guarantees it: the statement selects
     * `status = 'processing'` and sets `status = 'failed'`, so a matched row
     * always changes and a second call matches nothing. Widen the filter and
     * this is the assertion that goes red.
     */
    await seedJob({ id: 'aj-a', userId: USER, ageMs: 10 * 60_000 });
    await seedJob({ id: 'aj-b', userId: USER, ageMs: 10 * 60_000 });

    expect(await failOrphanedAudioJobs(db)).toBe(2);
    expect(await failOrphanedAudioJobs(db)).toBe(0);
  });

  it('counts nothing when nothing is stalled, and says so with a real number', async () => {
    // A vacuity floor for the two above: `0` has to be reachable for a genuine
    // empty table, or `toBe(2)` is only ever asserting that something happened.
    await seedJob({ id: 'aj-fresh-only', userId: USER, ageMs: 30_000 });
    expect(await failOrphanedAudioJobs(db)).toBe(0);
    expect(typeof (await failOrphanedAudioJobs(db))).toBe('number');
  });

  it('takes the cutoff from the caller so the boundary is testable', async () => {
    await seedJob({ id: 'aj-boundary', userId: USER, ageMs: 60_000 });

    // One minute old: not orphaned now, orphaned when `now` is ten minutes on.
    expect(await failOrphanedAudioJobs(db)).toBe(0);
    expect(await failOrphanedAudioJobs(db, new Date(Date.now() + 10 * 60_000))).toBe(1);
  });
});

describe('audio jobs are the shortest-lived rows in the schema', () => {
  /**
   * Moved here from `notifications.pgdb.test.ts` so that exactly one file writes
   * `audio_jobs` — see the file comment. The assertion is unchanged.
   */
  it('reaps a job older than 24 hours and keeps a fresh one', async () => {
    await seedJob({ id: 'aj-sweep-fresh', userId: USER, ageMs: 60_000 });
    await seedJob({ id: 'aj-sweep-stale', userId: USER, ageMs: 25 * 60 * 60_000 });

    await sweepAllExpiredRows(db, EXPIRY_TARGETS);

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${audioJobs} where user_id = ${USER} order by id`,
    );
    expect(rows.map((r) => r.id)).toEqual(['aj-sweep-fresh']);
  });
});
