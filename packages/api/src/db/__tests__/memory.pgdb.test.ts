import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { memoryEmbeddings, userMemories, userMemoryEntries } from '../schema/memory';

/**
 * Memory, against a REAL server.
 *
 * The functional unique below is the one thing here Mongo could not express at
 * all — it kept titles distinct with an in-JS array scan — so it is both the
 * batch's most valuable constraint and its most likely backfill failure.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const insertProfile = (id: string, oxyUserId: string) => db.execute(sql`
  insert into ${userMemories} (id, oxy_user_id) values (${id}, ${oxyUserId})
`);

const insertEntry = (id: string, profileId: string, title: string) => db.execute(sql`
  insert into ${userMemoryEntries} (id, user_memory_id, title, summary, type)
  values (${id}, ${profileId}, ${title}, 'a summary', 'topic')
`);

describe('a memory title is an identity, folded on case and whitespace', () => {
  it('refuses a title that differs only in case and surrounding space', async () => {
    await insertProfile('mem-p1', 'mem-user-1');
    await insertEntry('mem-e1', 'mem-p1', 'Coffee Preferences');

    /**
     * The fixture law applied: the second title MUST be in the un-normalised
     * form. Two already-lowercase, already-trimmed titles behave identically
     * under a plain unique and this functional one, so a test seeded that way
     * would pass while measuring nothing.
     *
     * This exact pair is what `lib/tools/user-memory.ts:60` treats as ONE
     * memory (`m.title.trim().toLowerCase() === normalized`), so the index is
     * making the application's own rule structural.
     */
    await expect(insertEntry('mem-e2', 'mem-p1', '  coffee preferences  ')).rejects.toSatisfy(
      (error: unknown) => {
        expect(isUniqueViolation(error)).toBe(true);
        expect(constraintNameOf(error)).toBe('user_memory_entries_memory_title_lower_key');
        return true;
      },
    );
  });

  it('scopes that to one profile, so two people can remember the same thing', async () => {
    await insertProfile('mem-p2', 'mem-user-2');
    await insertProfile('mem-p3', 'mem-user-3');
    await insertEntry('mem-e3', 'mem-p2', 'Coffee');
    await insertEntry('mem-e4', 'mem-p3', 'Coffee');

    /**
     * Scoped to the two profiles this case created. A run shares ONE database
     * across every `*.pgdb.test.ts` file, so an unscoped `where title =
     * 'Coffee'` counts whatever a sibling happened to seed — which is how this
     * read '6' the moment `userMemoryRepository.pgdb.test.ts` arrived with its
     * own coffee fixtures. Scoping loses nothing: what is being shown is that
     * BOTH of these profiles hold the title, which is what the per-profile
     * grain of the unique exists to allow.
     */
    const rows = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from ${userMemoryEntries}
      where title = 'Coffee' and user_memory_id in ('mem-p2', 'mem-p3')
    `);
    expect(rows[0]?.n).toBe('2');
  });

  it('keeps the stored title verbatim, folding only for the index', async () => {
    await insertProfile('mem-p4', 'mem-user-4');
    await insertEntry('mem-e5', 'mem-p4', '  Espresso Machine  ');

    const [row] = await db.execute<{ title: string }>(
      sql`select title from ${userMemoryEntries} where id = 'mem-e5'`,
    );
    /**
     * A functional index rather than a normalising setter, exactly as
     * `organizations.slug` chose: the column keeps what was written, so nothing
     * silently rewrites a user's own words. It also means the embedding's
     * `memory_key`, which stores this RAW value, still matches.
     */
    expect(row?.title).toBe('  Espresso Machine  ');
  });
});

describe('an entry cannot outlive its profile', () => {
  it('cascades the delete and leaves other profiles alone', async () => {
    await insertProfile('mem-p5', 'mem-user-5');
    await insertProfile('mem-p6', 'mem-user-6');
    await insertEntry('mem-e6', 'mem-p5', 'Goes away');
    await insertEntry('mem-e7', 'mem-p6', 'Stays');

    await db.execute(sql`delete from ${userMemories} where id = 'mem-p5'`);

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${userMemoryEntries} where id in ('mem-e6', 'mem-e7')`,
    );
    // Both halves: a cascade that took everything would satisfy "it is gone".
    expect(rows.map((r) => r.id)).toEqual(['mem-e7']);
  });
});

describe('an embedding is a plain array of doubles, and needs no extension', () => {
  it('round-trips fractional components exactly', async () => {
    const embedding = [0.125, -0.5, 0.0078125, 1];
    await db.execute(sql`
      insert into ${memoryEmbeddings} (id, oxy_user_id, memory_key, embedding)
      values ('mem-emb-1', 'mem-user-7', 'Coffee', ${sql.param(embedding)}::double precision[])
    `);

    const [row] = await db
      .select({ embedding: memoryEmbeddings.embedding })
      .from(memoryEmbeddings)
      .where(eq(memoryEmbeddings.id, 'mem-emb-1'));

    /**
     * `lib/memory/vector-search.ts:32` computes cosine similarity in
     * JavaScript, so what this column owes is an exact round trip and nothing
     * else — no distance operator, no index scan, and therefore no pgvector.
     * The values are chosen to be exactly representable in binary floating
     * point, so a failure here means the round trip, not the arithmetic.
     */
    expect(row?.embedding).toEqual(embedding);
  });

  it('refuses a second embedding for one (user, memory key)', async () => {
    const insert = (id: string) => db.execute(sql`
      insert into ${memoryEmbeddings} (id, oxy_user_id, memory_key, embedding)
      values (${id}, 'mem-user-8', 'Tea', ${sql.param([0.5])}::double precision[])
    `);
    await insert('mem-emb-2');

    await expect(insert('mem-emb-3')).rejects.toSatisfy((error: unknown) => {
      expect(constraintNameOf(error)).toBe('memory_embeddings_oxy_user_memory_key_key');
      return true;
    });
  });

  it('keys on the RAW title, which is why it has no foreign key to the entry', async () => {
    await insertProfile('mem-p7', 'mem-user-9');
    await insertEntry('mem-e8', 'mem-p7', '  Espresso  ');
    // `upsertMemoryEmbedding(oxyUserId, title, …)` passes the title verbatim,
    // while the entry's identity is `lower(trim(title))`. The two keys are
    // genuinely different values, so no FK could hold between them.
    await db.execute(sql`
      insert into ${memoryEmbeddings} (id, oxy_user_id, memory_key, embedding)
      values ('mem-emb-4', 'mem-user-9', '  Espresso  ', ${sql.param([0.25])}::double precision[])
    `);

    const [row] = await db.execute<{ memory_key: string }>(
      sql`select memory_key from ${memoryEmbeddings} where id = 'mem-emb-4'`,
    );
    expect(row?.memory_key).toBe('  Espresso  ');
  });
});

describe('the profile columns the interface claims are an open bag', () => {
  it('defaults interests to an empty array rather than null', async () => {
    await insertProfile('mem-p8', 'mem-user-10');

    const [row] = await db
      .select({ interests: userMemories.preferencesInterests })
      .from(userMemories)
      .where(eq(userMemories.id, 'mem-p8'));
    expect(row?.interests).toEqual([]);
  });

  it('refuses a response length outside the tuple', async () => {
    await expect(db.execute(sql`
      insert into ${userMemories} (id, oxy_user_id, preferences_response_length)
      values ('mem-badlen', 'mem-user-11', 'epic')
    `)).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('user_memories_preferences_response_length_check');
      return true;
    });
  });

  it('refuses a second profile for one account', async () => {
    await insertProfile('mem-p9', 'mem-user-12');

    await expect(insertProfile('mem-p10', 'mem-user-12')).rejects.toSatisfy((error: unknown) => {
      expect(constraintNameOf(error)).toBe('user_memories_oxy_user_id_key');
      return true;
    });
  });
});
