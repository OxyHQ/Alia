import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { ACTIVE_SHOW_STATUSES, SHOW_STATUSES, shows } from '../schema/notifications';
import {
  countActiveShows,
  createShow,
  deleteShowForUser,
  findShowById,
  findShowForUser,
  listShowsForUser,
  updateShow,
} from '../notifications/showRepository';

/**
 * Generated shows, against a REAL server.
 *
 * This file owns `shows`, so it clears the table between tests and the counts
 * are exact. Every fixture is created through the repository rather than raw
 * SQL where possible, so the CHECK constraints are exercised on the same path
 * production writes through.
 */

let db: ApiDatabase;
const USER = 'oxy-show-user';
const OTHER = 'oxy-show-other';

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  await db.delete(shows);
});

const newShow = (userId = USER, topic = 'the history of the metre') =>
  createShow(db, { userId, title: `Show: ${topic}`, topic, format: 'podcast' });

describe('creating a show', () => {
  it('starts queued at zero progress with empty jsonb arrays', async () => {
    const show = await newShow();
    expect(show).toMatchObject({
      userId: USER,
      status: 'queued',
      format: 'podcast',
      progress: 0,
      speakers: [],
      segments: [],
      audioUrl: null,
      jobId: null,
    });
  });

  it('leaves the optional source fields null rather than empty strings', async () => {
    const show = await newShow();
    expect(show.sourceNotes).toBeNull();
    expect(show.sourceConversationId).toBeNull();
  });
});

describe('the concurrency cap counts exactly the ACTIVE statuses', () => {
  it('counts a show in each active status and none of the terminal ones', async () => {
    for (const status of SHOW_STATUSES) {
      const show = await newShow();
      await updateShow(db, show.id, { status });
    }

    // One row per status exists; the cap must see exactly the active ones.
    expect(await countActiveShows(db, USER)).toBe(ACTIVE_SHOW_STATUSES.length);
    expect(ACTIVE_SHOW_STATUSES.length).toBe(4);
  });

  it('is scoped to the account, so one user cannot exhaust another cap', async () => {
    await newShow(USER);
    await newShow(USER);
    await newShow(OTHER);

    expect(await countActiveShows(db, USER)).toBe(2);
    expect(await countActiveShows(db, OTHER)).toBe(1);
  });

  it('returns a real number, not a bigint string', async () => {
    /**
     * `count()` is `bigint` in Postgres and postgres.js decodes `bigint` as a
     * STRING, while drizzle types it `number`. So `activeCount >= 3` in the
     * route would compare a string against a number and the cap would behave
     * unpredictably. `typeof` is the only assertion that can see this — the
     * value prints identically either way.
     */
    await newShow();
    const n = await countActiveShows(db, USER);
    expect(typeof n).toBe('number');
    expect(n).toBe(1);
  });

  it('counts zero for an account with no shows', async () => {
    // Vacuity floor: `0` has to be reachable, or the counts above only assert
    // that something was returned.
    expect(await countActiveShows(db, 'oxy-nobody')).toBe(0);
  });
});

describe('patching a show returns the row as it now stands', () => {
  it('gives back the updated values, which is what the pipeline accumulates on', async () => {
    /**
     * The pipeline reads `show.title` after a patch that may have set it. A
     * `void` signature would leave that read seeing the pre-patch local — the
     * one behaviour the Mongoose document gave for free.
     */
    const show = await newShow();
    const updated = await updateShow(db, show.id, { title: 'A Brief History of the Metre' });
    expect(updated?.title).toBe('A Brief History of the Metre');

    const reread = await findShowById(db, show.id);
    expect(reread?.title).toBe('A Brief History of the Metre');
  });

  it('round-trips the jsonb speakers and segments', async () => {
    const show = await newShow();
    const updated = await updateShow(db, show.id, {
      speakers: [{ name: 'Ada', voiceId: 'v1', voiceName: 'Ada Voice', role: 'host' }],
      segments: [{ index: 0, speaker: 'Ada', text: 'Hello.', type: 'dialogue' }],
    });

    expect(updated?.speakers).toEqual([
      { name: 'Ada', voiceId: 'v1', voiceName: 'Ada Voice', role: 'host' },
    ]);
    expect(updated?.segments).toEqual([
      { index: 0, speaker: 'Ada', text: 'Hello.', type: 'dialogue' },
    ]);
  });

  it('answers an empty patch with the current row rather than invalid SQL', async () => {
    // `UPDATE … SET` with nothing to set is a syntax error, and a caller with
    // nothing to change wants the row.
    const show = await newShow();
    const updated = await updateShow(db, show.id, {});
    expect(updated?.id).toBe(show.id);
  });

  it('answers null for a show that is gone', async () => {
    expect(await updateShow(db, 'no-such-show', { progress: 50 })).toBeNull();
  });

  it('advances updated_at, so the row records that it moved', async () => {
    const show = await newShow();
    const updated = await updateShow(db, show.id, { progress: 42 });
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(show.updatedAt.getTime());
    expect(updated?.progress).toBe(42);
  });
});

describe('reads are scoped to the owner, except the pipeline one', () => {
  it('refuses another account show by id', async () => {
    const show = await newShow(OTHER);
    expect(await findShowForUser(db, show.id, OTHER)).not.toBeNull();
    expect(await findShowForUser(db, show.id, USER)).toBeNull();
  });

  it('findShowById is deliberately unscoped — the pipeline owns the id', async () => {
    const show = await newShow(OTHER);
    expect((await findShowById(db, show.id))?.userId).toBe(OTHER);
  });

  it('answers a malformed id with a miss rather than raising', async () => {
    await expect(findShowForUser(db, 'not-an-id', USER)).resolves.toBeNull();
  });
});

describe('the list view', () => {
  it('leaves segments out entirely — the whole point of the projection', async () => {
    const show = await newShow();
    await updateShow(db, show.id, {
      segments: [{ index: 0, speaker: 'Ada', text: 'A very long transcript.', type: 'dialogue' }],
    });

    const { shows: page } = await listShowsForUser(db, USER, 20, 0);
    expect(page).toHaveLength(1);
    expect(page[0]).not.toHaveProperty('segments');
    // The positive half: the row IS the one carrying segments, so the absence
    // above is a projection rather than an empty table.
    expect((await findShowById(db, show.id))?.segments).toHaveLength(1);
  });

  it('orders newest first and pages without dropping or repeating a row', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const show = await newShow(USER, `topic number ${i}`);
      created.push(show.id);
    }

    const first = await listShowsForUser(db, USER, 2, 0);
    const second = await listShowsForUser(db, USER, 2, 2);
    const third = await listShowsForUser(db, USER, 2, 4);

    expect(first.total).toBe(5);
    const seen = [...first.shows, ...second.shows, ...third.shows].map((s) => s.id);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(new Set(seen)).toEqual(new Set(created));
  });

  it('breaks a created_at tie on the id, giving a TOTAL order', async () => {
    /**
     * `generatedId()` is a uuid v7 and is NOT monotonic within a millisecond, so
     * rows created in a tight loop can share a `created_at`. `ORDER BY
     * created_at DESC` alone is then not a total order, and `LIMIT`/`OFFSET`
     * paging over a partial order can repeat or drop a row.
     *
     * ## Asserting the disjointness of two pages does NOT test this
     *
     * Measured: a version of this test that inserted three tied rows and checked
     * two pages did not overlap PASSED with the tiebreak removed, because
     * Postgres happens to return a small table in physical order both times. An
     * unspecified order is free to be stable, so "it did not go wrong" is not
     * evidence of a guarantee.
     *
     * What IS checkable is the order the clause specifies. The ids ascend, so
     * the correct query must return them DESCENDING; the unordered version
     * returns physical order, which is the opposite. That kills the mutation
     * because it asserts the contract rather than hoping to observe its absence.
     */
    await db.insert(shows).values(
      ['s-a', 's-b', 's-c'].map((id) => ({
        id,
        userId: USER,
        title: id,
        topic: 't',
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      })),
    );

    const { shows: page } = await listShowsForUser(db, USER, 3, 0);
    expect(page.map((s) => s.id)).toEqual(['s-c', 's-b', 's-a']);

    // And the paging consequence the total order buys, kept as the property
    // anybody actually cares about.
    const first = await listShowsForUser(db, USER, 2, 0);
    const second = await listShowsForUser(db, USER, 2, 2);
    const ids = [...first.shows, ...second.shows].map((s) => s.id);
    expect(ids).toEqual(['s-c', 's-b', 's-a']);
  });

  it('reports a real number for the total', async () => {
    await newShow();
    const { total } = await listShowsForUser(db, USER, 20, 0);
    expect(typeof total).toBe('number');
    expect(total).toBe(1);
  });

  it('answers an empty page for an account with nothing', async () => {
    const page = await listShowsForUser(db, 'oxy-nobody', 20, 0);
    expect(page).toEqual({ shows: [], total: 0 });
  });

  it('is scoped, so a list never leaks another account show', async () => {
    await newShow(OTHER);
    expect((await listShowsForUser(db, USER, 20, 0)).total).toBe(0);
  });
});

describe('deleting', () => {
  it('reports whether the show existed, which is what the 404 turns on', async () => {
    const show = await newShow();
    expect(await deleteShowForUser(db, show.id, USER)).toBe(true);
    // The REPEAT is what separates "deleted it" from "matched something":
    // a second delete of the same id must report false.
    expect(await deleteShowForUser(db, show.id, USER)).toBe(false);
  });

  it('refuses to delete another account show, and leaves it there', async () => {
    const show = await newShow(OTHER);
    expect(await deleteShowForUser(db, show.id, USER)).toBe(false);
    expect(await findShowById(db, show.id)).not.toBeNull();
  });
});

describe('the closed value sets are enforced by the database, not by convention', () => {
  it('refuses a format outside the tuple', async () => {
    const show = await newShow();
    await expect(
      db.update(shows).set({ format: 'telenovela' as never }).where(eq(shows.id, show.id)),
    ).rejects.toThrow();
  });

  it('refuses a status outside the tuple', async () => {
    const show = await newShow();
    await expect(
      db.update(shows).set({ status: 'nearly_done' as never }).where(eq(shows.id, show.id)),
    ).rejects.toThrow();
  });
});
