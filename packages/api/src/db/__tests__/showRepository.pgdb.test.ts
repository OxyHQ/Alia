import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  ACTIVE_SHOW_EPISODE_STATUSES,
  SHOW_EPISODE_STATUSES,
  showEpisodes,
  showPreferences,
  showSeries,
} from '../schema/shows';
import {
  allocateEpisodeNumber,
  countActiveEpisodes,
  createEpisode,
  createSeries,
  deleteEpisodeForUser,
  deleteSeriesForUser,
  findEpisodeById,
  findEpisodeForUser,
  findPreferences,
  findSeriesForUser,
  listEpisodesForSeries,
  listSeriesForUser,
  recentRecaps,
  updateEpisode,
  updateSeriesForUser,
  upsertPreferences,
} from '../shows/showRepository';

/**
 * Show series and episodes, against a REAL server.
 *
 * Four things here cannot be tested without one, and each is a place the old
 * flat `shows` table had nothing to say:
 *
 *  - the `ON DELETE CASCADE` from a series to its episodes;
 *  - the unique on `(series_id, episode_number)`, which is what makes the
 *    atomic allocation provable rather than hopeful;
 *  - the `ingest_ticket` codec, which encrypts on the way in and would store
 *    plaintext if the column were plain `text`;
 *  - the INDEXES, which no functional test can ever detect the absence of, so
 *    they are asserted against `pg_indexes` by name.
 *
 * This file owns `show_series`, `show_episodes` and `show_preferences`, so it
 * clears them between tests and its counts are exact.
 */

let db: ApiDatabase;
const USER = 'oxy-show-user';
const OTHER = 'oxy-show-other';

beforeAll(() => {
  // The `encryptedText` codec reads this LAZILY, on first use rather than at
  // import, so setting it here is early enough — and `??=` leaves a real key
  // alone if one is already exported.
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  // Episodes first would be redundant given the cascade, but the cascade is
  // itself under test — clearing the parent alone would make a broken cascade
  // look like a passing fixture.
  await db.delete(showEpisodes);
  await db.delete(showSeries);
  await db.delete(showPreferences);
});

const seed = (userId = USER, syraPodcastId = 'syra-pod-1') =>
  createSeries(db, {
    // Minted by the caller, as the route does: Syra's podcast has to exist
    // before this row and wants this id, so the column's default is too late.
    id: uuidv7(),
    userId,
    syraPodcastId,
    title: 'The Wednesday Digest',
    format: 'podcast',
    brief: 'A weekly look at whatever the owner has been reading.',
    speakers: [{ name: 'Marcus', voiceId: 'v1', voiceName: 'Marcus', role: 'host' }],
    visibility: 'private',
  });

const seedEpisode = (seriesId: string, episodeNumber: number, userId = USER) =>
  createEpisode(db, {
    userId,
    seriesId,
    episodeNumber,
    title: `Episode ${episodeNumber}`,
    topic: 'what happened this week',
    syraEpisodeId: `syra-ep-${episodeNumber}`,
    ingestTicket: `ticket-${episodeNumber}`,
    ingestTicketExpiresAt: new Date(Date.now() + 86_400_000),
  });

/* -------------------------------------------------------------------------- */
/*  The indexes                                                               */
/* -------------------------------------------------------------------------- */

describe('the schema really carries the indexes it declares', () => {
  /**
   * An index is the one thing a functional test can never detect the absence
   * of: every query in this file returns identical rows with or without them,
   * just slower. So they are read back out of the catalogue by name.
   */
  it('created every declared index, and the primary keys', async () => {
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
       where schemaname = 'public'
         and tablename in ('show_series', 'show_episodes', 'show_preferences')
       order by indexname
    `);

    expect(rows.map((r) => r.indexname)).toEqual([
      'show_episodes_pkey',
      'show_episodes_series_number_idx',
      'show_episodes_series_number_key',
      'show_episodes_user_status_idx',
      'show_preferences_pkey',
      'show_series_pkey',
      'show_series_syra_podcast_id_key',
      'show_series_user_created_at_idx',
    ]);
  });

  it('and the old flat table is gone rather than merely unused', async () => {
    // The `post` migration's whole content. A table left behind would keep
    // every reader compiling and would quietly hold the rows this cut removed.
    const rows = await db.execute<{ tablename: string }>(sql`
      select tablename from pg_tables where schemaname = 'public' and tablename = 'shows'
    `);
    expect(rows).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Series                                                                    */
/* -------------------------------------------------------------------------- */

describe('a series', () => {
  it('stores what it was given and defaults the rest', async () => {
    const series = await seed();
    expect(series.visibility).toBe('private');
    expect(series.nextEpisodeNumber).toBe(1);
    expect(series.speakers).toEqual([
      { name: 'Marcus', voiceId: 'v1', voiceName: 'Marcus', role: 'host' },
    ]);
  });

  it('refuses a second series pointing at the same Syra podcast', async () => {
    await seed();
    // Named constraint, not `isUniqueViolation` alone: that helper cannot tell
    // the index under test from any other unique on the table.
    await expect(seed(OTHER, 'syra-pod-1')).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err, 'show_series_syra_podcast_id_key'),
    );
  });

  it('is invisible to another account by id', async () => {
    const series = await seed();
    expect(await findSeriesForUser(db, series.id, OTHER)).toBeNull();
    expect(await findSeriesForUser(db, series.id, USER)).not.toBeNull();
  });

  it('cannot be patched by another account', async () => {
    const series = await seed();
    expect(await updateSeriesForUser(db, series.id, OTHER, { title: 'Stolen' })).toBeNull();

    const [after] = await db.select().from(showSeries).where(eq(showSeries.id, series.id));
    expect(after?.title).toBe('The Wednesday Digest');
  });

  it('lists an account its own series and nobody else\'s, newest first', async () => {
    const mine = await seed(USER, 'syra-pod-mine');
    await seed(OTHER, 'syra-pod-theirs');

    const page = await listSeriesForUser(db, USER, 20, 0);
    expect(page.total).toBe(1);
    expect(page.series.map((s) => s.id)).toEqual([mine.id]);
  });

  it('refuses a visibility the CHECK does not know', async () => {
    const series = await seed();
    await expect(
      db
        .update(showSeries)
        .set({ visibility: 'friends-only' as never })
        .where(eq(showSeries.id, series.id)),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*  Episode numbering                                                         */
/* -------------------------------------------------------------------------- */

describe('allocating an episode number', () => {
  it('hands out 1, then 2, and advances the series counter', async () => {
    const series = await seed();
    expect(await allocateEpisodeNumber(db, series.id, USER)).toBe(1);
    expect(await allocateEpisodeNumber(db, series.id, USER)).toBe(2);

    const after = await findSeriesForUser(db, series.id, USER);
    expect(after?.nextEpisodeNumber).toBe(3);
  });

  it('never hands the same number to two concurrent callers', async () => {
    const series = await seed();

    /**
     * The discriminator for a read-then-write. Issued together on the pool, so
     * both statements are in flight before either commits — a repository that
     * read the counter and then wrote it would give both callers 1 here, and a
     * single sequential call could never tell the two implementations apart.
     */
    const allocated = await Promise.all([
      allocateEpisodeNumber(db, series.id, USER),
      allocateEpisodeNumber(db, series.id, USER),
      allocateEpisodeNumber(db, series.id, USER),
    ]);

    expect([...allocated].sort()).toEqual([1, 2, 3]);
    expect(new Set(allocated).size).toBe(3);
  });

  it('answers null for another account, without touching the counter', async () => {
    const series = await seed();
    expect(await allocateEpisodeNumber(db, series.id, OTHER)).toBeNull();

    const after = await findSeriesForUser(db, series.id, USER);
    expect(after?.nextEpisodeNumber).toBe(1);
  });

  it('and the unique index refuses a duplicate number if anything gets past it', async () => {
    const series = await seed();
    await seedEpisode(series.id, 1);

    await expect(seedEpisode(series.id, 1)).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err, 'show_episodes_series_number_key'),
    );
  });

  it('but the same number in a DIFFERENT series is fine', async () => {
    const a = await seed(USER, 'syra-pod-a');
    const b = await seed(USER, 'syra-pod-b');
    await seedEpisode(a.id, 1);
    await expect(seedEpisode(b.id, 1)).resolves.toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/*  The ingest ticket                                                         */
/* -------------------------------------------------------------------------- */

describe('the ingest ticket', () => {
  it('is stored encrypted and read back as itself', async () => {
    const series = await seed();
    const episode = await seedEpisode(series.id, 1);

    // Through the builder: the codec's `fromDriver` runs, so this is plaintext.
    const read = await findEpisodeById(db, episode.id);
    expect(read?.ingestTicket).toBe('ticket-1');

    /**
     * Through the RAW driver, which bypasses the codec entirely — this is what
     * is actually on disk. Asserting the SHAPE rather than merely "not equal":
     * a column that silently stopped encrypting would still differ from the
     * plaintext under some transformations, while `iv:authTag:ciphertext` is
     * the one thing only the codec produces.
     */
    const [raw] = await db.execute<{ ingest_ticket: string }>(sql`
      select ingest_ticket from show_episodes where id = ${episode.id}
    `);
    expect(raw?.ingest_ticket).not.toBe('ticket-1');
    expect(raw?.ingest_ticket).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  it('never reaches a route-facing read', async () => {
    const series = await seed();
    const episode = await seedEpisode(series.id, 1);

    const seen = await findEpisodeForUser(db, episode.id, USER);
    expect(seen).not.toBeNull();
    // `in`, not a truthiness check: a column selected as `null` is still a
    // column this projection emitted, and that is the thing being refused.
    expect(seen === null ? [] : Object.keys(seen)).not.toContain('ingestTicket');
    expect(seen === null ? [] : Object.keys(seen)).not.toContain('ingestTicketExpiresAt');

    const [listed] = (await listEpisodesForSeries(db, series.id, 20, 0)).episodes;
    expect(listed === undefined ? [] : Object.keys(listed)).not.toContain('ingestTicket');
  });

  it('clears to null once spent, and a null round-trips through the codec', async () => {
    const series = await seed();
    const episode = await seedEpisode(series.id, 1);

    const spent = await updateEpisode(db, episode.id, { ingestTicket: null });
    expect(spent?.ingestTicket).toBeNull();

    // Re-read rather than trusting RETURNING: `fromDriver` throws on anything
    // that is not well-formed ciphertext, so a null it could not handle would
    // fail HERE rather than on the next pipeline run.
    expect((await findEpisodeById(db, episode.id))?.ingestTicket).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Episodes                                                                  */
/* -------------------------------------------------------------------------- */

describe('episodes', () => {
  it('counts exactly the statuses the schema calls active', async () => {
    const series = await seed();
    for (const [i, status] of SHOW_EPISODE_STATUSES.entries()) {
      const episode = await seedEpisode(series.id, i + 1);
      await updateEpisode(db, episode.id, { status });
    }

    expect(await countActiveEpisodes(db, USER)).toBe(ACTIVE_SHOW_EPISODE_STATUSES.length);
    // A floor with a number in it, so a tuple that silently loses a member
    // fails here rather than quietly lowering the cap.
    expect(ACTIVE_SHOW_EPISODE_STATUSES.length).toBe(5);
    expect(SHOW_EPISODE_STATUSES).toHaveLength(7);
  });

  it('counts zero for an account with none', async () => {
    expect(await countActiveEpisodes(db, OTHER)).toBe(0);
  });

  it('lists a series highest-numbered first', async () => {
    const series = await seed();
    await seedEpisode(series.id, 1);
    await seedEpisode(series.id, 2);
    await seedEpisode(series.id, 3);

    const page = await listEpisodesForSeries(db, series.id, 20, 0);
    expect(page.total).toBe(3);
    expect(page.episodes.map((e) => e.episodeNumber)).toEqual([3, 2, 1]);
  });

  it('is invisible to another account by id', async () => {
    const series = await seed();
    const episode = await seedEpisode(series.id, 1);
    expect(await findEpisodeForUser(db, episode.id, OTHER)).toBeNull();
  });

  it('cannot be deleted by another account', async () => {
    const series = await seed();
    const episode = await seedEpisode(series.id, 1);

    expect(await deleteEpisodeForUser(db, episode.id, OTHER)).toBe(false);
    expect(await findEpisodeById(db, episode.id)).not.toBeNull();
    expect(await deleteEpisodeForUser(db, episode.id, USER)).toBe(true);
    expect(await findEpisodeById(db, episode.id)).toBeNull();
  });

  it('goes with its series, by the cascade rather than by a second statement', async () => {
    const series = await seed();
    await seedEpisode(series.id, 1);
    await seedEpisode(series.id, 2);

    expect(await deleteSeriesForUser(db, series.id, USER)).toBe(true);

    const survivors = await db.select().from(showEpisodes);
    expect(survivors).toHaveLength(0);
  });

  it('and a series another account owns cascades nothing', async () => {
    const series = await seed();
    await seedEpisode(series.id, 1);

    expect(await deleteSeriesForUser(db, series.id, OTHER)).toBe(false);
    expect(await db.select().from(showEpisodes)).toHaveLength(1);
  });

  it('refuses a status the CHECK does not know', async () => {
    const series = await seed();
    const episode = await seedEpisode(series.id, 1);
    await expect(
      db
        .update(showEpisodes)
        .set({ status: 'nearly_done' as never })
        .where(eq(showEpisodes.id, episode.id)),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*  Continuity                                                                */
/* -------------------------------------------------------------------------- */

describe('recaps, which are what make a series continuous', () => {
  it('returns the previous episodes oldest first, bounded by the limit', async () => {
    const series = await seed();
    for (const n of [1, 2, 3, 4]) {
      const episode = await seedEpisode(series.id, n);
      await updateEpisode(db, episode.id, { recap: `recap ${n}` });
    }

    // Episode 5 asks for the two before it: 4 and 3, read in listening order.
    expect(await recentRecaps(db, series.id, 5, 2)).toEqual(['recap 3', 'recap 4']);
  });

  it('never returns an episode at or after the one asking', async () => {
    const series = await seed();
    for (const n of [1, 2, 3]) {
      const episode = await seedEpisode(series.id, n);
      await updateEpisode(db, episode.id, { recap: `recap ${n}` });
    }

    // The bug this catches is an off-by-one that feeds episode 2 its OWN recap,
    // which reads as a model repeating itself rather than as a query fault.
    expect(await recentRecaps(db, series.id, 2, 5)).toEqual(['recap 1']);
    expect(await recentRecaps(db, series.id, 1, 5)).toEqual([]);
  });

  it('skips an episode that has no recap rather than yielding a gap', async () => {
    const series = await seed();
    const first = await seedEpisode(series.id, 1);
    await updateEpisode(db, first.id, { recap: 'recap 1' });
    // Episode 2 failed before it could write one.
    await seedEpisode(series.id, 2);

    expect(await recentRecaps(db, series.id, 3, 5)).toEqual(['recap 1']);
  });

  it('does not reach into another series', async () => {
    const a = await seed(USER, 'syra-pod-a');
    const b = await seed(USER, 'syra-pod-b');
    const episode = await seedEpisode(a.id, 1);
    await updateEpisode(db, episode.id, { recap: 'from series a' });

    expect(await recentRecaps(db, b.id, 5, 5)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Preferences                                                               */
/* -------------------------------------------------------------------------- */

describe('preferences', () => {
  it('are absent until somebody sets one, and absence is not an error', async () => {
    expect(await findPreferences(db, USER)).toBeNull();
  });

  it('are created on first write and replaced on the second', async () => {
    const created = await upsertPreferences(db, USER, {
      defaultVisibility: 'unlisted',
      defaultFormat: 'interview',
    });
    expect(created.defaultVisibility).toBe('unlisted');

    const updated = await upsertPreferences(db, USER, {
      defaultVisibility: 'public',
      defaultFormat: 'news',
    });
    expect(updated.defaultVisibility).toBe('public');
    expect(updated.defaultFormat).toBe('news');

    // ONE row, not two. A repeated call is the discriminator: an insert that
    // merely ignored the conflict would leave the first row in place and read
    // back the old value, and a single call could not tell the two apart.
    expect(await db.select().from(showPreferences)).toHaveLength(1);
  });

  it('are keyed by the account, so two accounts do not share one', async () => {
    await upsertPreferences(db, USER, { defaultVisibility: 'public', defaultFormat: 'news' });
    await upsertPreferences(db, OTHER, { defaultVisibility: 'private', defaultFormat: 'debate' });

    expect((await findPreferences(db, USER))?.defaultVisibility).toBe('public');
    expect((await findPreferences(db, OTHER))?.defaultVisibility).toBe('private');
  });
});
