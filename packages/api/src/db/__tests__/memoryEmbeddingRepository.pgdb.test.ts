import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  deleteMemoryEmbedding,
  listMemoryEmbeddings,
  upsertMemoryEmbedding,
} from '../memory/memoryEmbeddingRepository';
import { memoryEmbeddings } from '../schema/memory';

/**
 * The `memory_embeddings` repository, against a real server.
 *
 * `db/__tests__/memory.pgdb.test.ts` covers the SCHEMA — the unique, the
 * round trip, the absent foreign key. This file covers what the repository
 * does with it, so every case here fails if a function silently does nothing.
 * That distinction matters more than usual: the source store is gone, and a
 * recall that returns no vectors is indistinguishable from a user who has saved
 * no memories.
 *
 * Accounts are namespaced `mer-*` per test. The pgdb suite shares ONE database
 * across files, `(oxy_user_id, memory_key)` is a unique key, and
 * `memory.pgdb.test.ts` already writes `mem-user-*` rows into this same table.
 * Nothing here is time-sensitive, but nothing here is absolute either.
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

/**
 * Through `eq()`, not a raw `sql` template — the builder routes values through
 * the column's own mapper. It is also the only read here that sees the stored
 * row rather than the repository's projection, which is the point: a repository
 * asserted solely against its own read cannot distinguish "stored correctly"
 * from "read back the same way it was written wrongly".
 *
 * Throws rather than returning `undefined`, so every caller below reads a real
 * row. Optional-chaining the absent case instead would let a write that stored
 * NOTHING skip every following expectation and pass having measured nothing.
 */
async function readRow(oxyUserId: string, memoryKey: string) {
  const [row] = await db
    .select()
    .from(memoryEmbeddings)
    .where(
      and(eq(memoryEmbeddings.oxyUserId, oxyUserId), eq(memoryEmbeddings.memoryKey, memoryKey)),
    );
  if (!row) throw new Error(`no embedding stored for ${oxyUserId} / ${memoryKey}`);
  return row;
}

describe('storing a vector', () => {
  it('inserts on the first save and REPLACES on the second, without a second row', async () => {
    const user = 'mer-replace';

    await upsertMemoryEmbedding(db, user, 'Coffee', [0.5, 0.25]);
    expect((await readRow(user, 'Coffee')).embedding).toEqual([0.5, 0.25]);

    /**
     * The second call is what separates an upsert from an insert-only path: a
     * repository without `ON CONFLICT` throws here, and one that appended would
     * satisfy the value assertion while leaving two rows.
     */
    await upsertMemoryEmbedding(db, user, 'Coffee', [-1, 0.125]);
    expect((await readRow(user, 'Coffee')).embedding).toEqual([-1, 0.125]);

    const all = await db
      .select()
      .from(memoryEmbeddings)
      .where(eq(memoryEmbeddings.oxyUserId, user));
    expect(all).toHaveLength(1);
  });

  it('moves `updated_at` forward on the replacing write', async () => {
    const user = 'mer-touch';
    await upsertMemoryEmbedding(db, user, 'Tea', [0.5]);

    /**
     * The stored `updated_at` is driven into the past before the second write,
     * rather than comparing two timestamps taken moments apart.
     *
     * `date_trunc('milliseconds', now())` can return the SAME value for two
     * rapid calls, so `second >= first` holds whether or not the `set` clause
     * touches the column — an assertion that cannot fail. Backdating makes the
     * two outcomes differ by an hour, and does it RELATIVE to now, so nothing
     * here rots into a fixed instant.
     */
    const backdated = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .update(memoryEmbeddings)
      .set({ updatedAt: backdated })
      .where(and(eq(memoryEmbeddings.oxyUserId, user), eq(memoryEmbeddings.memoryKey, 'Tea')));

    const first = await readRow(user, 'Tea');
    expect(first.updatedAt.getTime()).toBe(backdated.getTime());

    await upsertMemoryEmbedding(db, user, 'Tea', [0.75]);
    const second = await readRow(user, 'Tea');

    /**
     * What this pins is that `@oxyhq/db`'s `$onUpdate` fires for an
     * `onConflictDoUpdate`, not only for `db.update()` — which is why the
     * repository does not name `updatedAt` in its `set` at all. Non-obvious
     * enough to be worth a regression test: replacing the upsert with a raw
     * statement, or with a plain `values()`, leaves the backdated value here.
     *
     * Note the honest limit — no assertion in this file can distinguish naming
     * `updatedAt` in the `set` from omitting it, because the two compile to the
     * same behaviour. That equivalence is the measurement, and it is recorded
     * in the repository rather than pretended away here.
     */
    expect(second.updatedAt.getTime()).toBeGreaterThan(backdated.getTime());
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
  });

  it('keeps one account\'s vectors out of another\'s under the same key', async () => {
    await upsertMemoryEmbedding(db, 'mer-scope-a', 'Shared Title', [1, 0]);
    await upsertMemoryEmbedding(db, 'mer-scope-b', 'Shared Title', [0, 1]);

    expect((await readRow('mer-scope-a', 'Shared Title')).embedding).toEqual([1, 0]);
    expect((await readRow('mer-scope-b', 'Shared Title')).embedding).toEqual([0, 1]);
  });

  it('keys on the RAW memory key, so case and surrounding space are distinct', async () => {
    const user = 'mer-verbatim';
    await upsertMemoryEmbedding(db, user, 'Espresso', [1]);
    await upsertMemoryEmbedding(db, user, '  espresso  ', [0]);

    /**
     * `user_memory_entries` folds titles with `lower(trim(title))`; this table
     * deliberately does not. Two rows here is the schema's stated consequence,
     * and it is what makes the rename path's explicit delete load-bearing.
     */
    const all = await db
      .select()
      .from(memoryEmbeddings)
      .where(eq(memoryEmbeddings.oxyUserId, user));
    expect(all).toHaveLength(2);
  });
});

describe('reading vectors back for the in-JavaScript scan', () => {
  it('returns every vector for the account and NOTHING for another', async () => {
    const user = 'mer-list';
    await upsertMemoryEmbedding(db, user, 'One', [0.5, 0.5]);
    await upsertMemoryEmbedding(db, user, 'Two', [0.25, -0.25]);
    await upsertMemoryEmbedding(db, 'mer-list-other', 'Three', [1, 1]);

    const mine = await listMemoryEmbeddings(db, user);
    // Sorted here, not in SQL: the repository deliberately imposes no order,
    // and asserting one would pin behaviour the caller does not rely on.
    expect(mine.map((e) => e.memoryKey).sort()).toEqual(['One', 'Two']);

    /**
     * The negative half needs the positive half beside it: "no rows for this
     * account" is also what a broken `where` returning nothing at all reports.
     */
    const theirs = await listMemoryEmbeddings(db, 'mer-list-other');
    expect(theirs.map((e) => e.memoryKey)).toEqual(['Three']);
  });

  it('returns an empty array, not a throw, for an account with no memories', async () => {
    expect(await listMemoryEmbeddings(db, 'mer-nobody')).toEqual([]);
  });

  it('decodes the vector as NUMBERS, exactly, not as strings', async () => {
    /**
     * `double precision[]` is not the `bigint` case — `int8` reaches JavaScript
     * as a string through postgres.js while drizzle types it `number`, and the
     * same wrong-but-typed-right shape would make `cosineSimilarity` return
     * `NaN` rather than fail. `typeof` is the only assertion that can tell
     * them apart, because `toEqual` on `['0.5']` vs `[0.5]` is the sole
     * difference and the arithmetic downstream is silent about it.
     *
     * The components are exactly representable in binary floating point, so a
     * failure here is the decode, never the rounding.
     */
    const user = 'mer-numeric';
    await upsertMemoryEmbedding(db, user, 'Precise', [0.125, -0.5, 0.0078125, 2]);

    const [stored] = await listMemoryEmbeddings(db, user);
    expect(stored).toBeDefined();
    expect(stored.embedding).toEqual([0.125, -0.5, 0.0078125, 2]);
    for (const component of stored.embedding) {
      expect(typeof component).toBe('number');
    }
  });
});

describe('forgetting a vector', () => {
  it('removes only the named key and reports that one row went', async () => {
    const user = 'mer-delete';
    await upsertMemoryEmbedding(db, user, 'Goes', [1]);
    await upsertMemoryEmbedding(db, user, 'Stays', [0]);

    /**
     * The count comes off `result.count`. For a DELETE the returned row set is
     * empty either way, so a repository reading `rows.length` would return a
     * plausible, always-zero answer — and the rename path at
     * `lib/tools/user-memory.ts:195` is what reads it to know whether the old
     * embedding was actually orphaned.
     */
    expect(await deleteMemoryEmbedding(db, user, 'Goes')).toBe(1);

    const left = await listMemoryEmbeddings(db, user);
    expect(left.map((e) => e.memoryKey)).toEqual(['Stays']);
  });

  it('reports ZERO when nothing matched, rather than claiming a deletion', async () => {
    const user = 'mer-delete-miss';
    await upsertMemoryEmbedding(db, user, 'Present', [1]);

    // A stale rename target. Zero is the answer that tells the caller the old
    // embedding was never there to orphan.
    expect(await deleteMemoryEmbedding(db, user, 'Absent')).toBe(0);
    expect(await deleteMemoryEmbedding(db, 'mer-delete-nobody', 'Present')).toBe(0);
    // ...and the row that DOES match is still reachable, so the zero above was
    // a miss rather than a delete that swept the account.
    expect(await listMemoryEmbeddings(db, user)).toHaveLength(1);
  });
});
