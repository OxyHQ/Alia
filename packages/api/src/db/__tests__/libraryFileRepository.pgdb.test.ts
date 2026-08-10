import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createLibraryFile,
  deleteLibraryFile,
  findLibraryFile,
  listLibraryFiles,
  toLibraryFileResponse,
} from '../library/libraryFileRepository';
import { libraryFiles } from '../schema/library';

/**
 * The `library_files` repository, against a real server.
 *
 * The source store is gone, so an empty library and a broken owner filter are
 * the same observable in production. Every read case here therefore carries the
 * positive half beside the negative one.
 *
 * Owners are namespaced `lfr-*` per test: the pgdb suite shares ONE database
 * across files, and ordering cases must not see another test's rows.
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

const seed = (owner: string, name: string, extra: Partial<Parameters<typeof createLibraryFile>[1]> = {}) =>
  createLibraryFile(db, {
    ownerOxyUserId: owner,
    name,
    url: `https://example.invalid/${name}`,
    type: 'application/pdf',
    size: 1024,
    category: 'documents',
    ...extra,
  });

describe('recording an upload', () => {
  it('stores the account under `owner_oxy_user_id`, which Mongoose called `owner`', async () => {
    const row = await seed('lfr-owner', 'notes.pdf');

    /**
     * Read back through the COLUMN, not through the repository's own
     * projection. This is the one mapping in the domain that a name-derived
     * backfill would get wrong, and the failure mode is a null owner with every
     * write reporting success — so the assertion has to name the column.
     */
    const [stored] = await db
      .select({ owner: libraryFiles.ownerOxyUserId })
      .from(libraryFiles)
      .where(eq(libraryFiles.id, row.id));
    expect(stored?.owner).toBe('lfr-owner');
  });

  it('stores an absent thumbnail as NULL and omits it from the wire shape', async () => {
    const without = await seed('lfr-thumb', 'plain.pdf');
    expect(without.thumbnail).toBeNull();
    /**
     * Mongo's `lean()` left an unset optional field off the document entirely.
     * `'thumbnail' in …` rather than a value check: `undefined` and absent are
     * the same to `toEqual`, and only the key's presence decides what
     * `JSON.stringify` puts on the wire.
     */
    expect('thumbnail' in toLibraryFileResponse(without)).toBe(false);

    const withOne = await seed('lfr-thumb', 'photo.png', {
      thumbnail: 'https://example.invalid/thumb.png',
      category: 'images',
    });
    expect(toLibraryFileResponse(withOne).thumbnail).toBe('https://example.invalid/thumb.png');
  });

  it('refuses a category outside the tuple the CHECK is rendered from', async () => {
    await expect(
      seed('lfr-badcat', 'weird.bin', {
        category: 'archives' as unknown as Parameters<typeof createLibraryFile>[1]['category'],
      }),
    ).rejects.toThrow();
  });
});

describe('the wire shape a shipped client reads', () => {
  it('serves `_id` from the Postgres id', async () => {
    const row = await seed('lfr-wire', 'doc.pdf');
    const wire = toLibraryFileResponse(row);

    /**
     * `packages/app/lib/stores/library-store.ts:93` filters the store on
     * `file._id`. Renaming it to `id` would leave the shipped mobile build
     * unable to delete a file, with no error anywhere.
     */
    expect(wire._id).toBe(row.id);
    expect(wire._id).toBeTruthy();
  });

  it('serves `size` as a NUMBER, which is the trap this column carries', async () => {
    const row = await seed('lfr-size', 'big.pdf', { size: 9_007_199_254 });

    /**
     * `size` is `bigint({ mode: 'number' })`, and the mode is applied by
     * drizzle's RESULT MAPPER — so the same column reaches JavaScript as a
     * `number` through the query builder and as a `string` through a raw
     * `db.execute`, with `tsc` typing both `number`. A string would serialise
     * to `"9007199254"` and reach a client declaring `size: number`, where it
     * formats as a plausible file size and never throws.
     *
     * `typeof` is the only assertion that separates them: `toBe` on a string
     * would fail, but `toEqual`-style checks and every arithmetic use downstream
     * are silent about it.
     */
    expect(typeof row.size).toBe('number');
    expect(row.size).toBe(9_007_199_254);
    expect(typeof toLibraryFileResponse(row).size).toBe('number');

    // The other half of the same fact, so the claim above is measured rather
    // than asserted: the RAW path returns the identical row's column as text.
    const [raw] = await db.execute<{ size: unknown }>(
      sql`select size from ${libraryFiles} where id = ${row.id}`,
    );
    expect(typeof raw?.size).toBe('string');
  });
});

describe('listing an owner\'s files', () => {
  it('returns only this owner\'s rows, newest first', async () => {
    const owner = 'lfr-list';
    const older = await seed(owner, 'older.pdf');
    // `created_at` defaults to `now()` and two inserts can land in one
    // millisecond, so the ordering fixture is written EXPLICITLY rather than
    // relying on insert order — and relative to now, never a fixed instant.
    await db
      .update(libraryFiles)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(libraryFiles.id, older.id));
    const newer = await seed(owner, 'newer.pdf');
    await seed('lfr-list-other', 'theirs.pdf');

    const mine = await listLibraryFiles(db, owner);
    expect(mine.map((f) => f.id)).toEqual([newer.id, older.id]);

    /**
     * The other owner's read is the positive control for the negative half
     * above: without it, "the other owner's file is absent from mine" is also
     * what a query returning nothing at all would report.
     */
    const theirs = await listLibraryFiles(db, 'lfr-list-other');
    expect(theirs.map((f) => f.name)).toEqual(['theirs.pdf']);
  });

  it('narrows to a category, and returns everything when none is given', async () => {
    const owner = 'lfr-cat';
    await seed(owner, 'a.pdf', { category: 'documents' });
    await seed(owner, 'b.png', { category: 'images' });

    expect((await listLibraryFiles(db, owner, 'images')).map((f) => f.name)).toEqual(['b.png']);
    expect((await listLibraryFiles(db, owner, 'documents')).map((f) => f.name)).toEqual(['a.pdf']);
    // Both, when unfiltered — so the two above are filtering rather than the
    // table simply holding one row per category.
    expect((await listLibraryFiles(db, owner)).map((f) => f.name).sort()).toEqual(['a.pdf', 'b.png']);
  });

  it('returns an empty array for an owner with nothing', async () => {
    expect(await listLibraryFiles(db, 'lfr-nobody')).toEqual([]);
  });
});

describe('reading and removing one file', () => {
  it('finds this owner\'s file and NOT another account\'s', async () => {
    const mine = await seed('lfr-find', 'mine.pdf');

    expect((await findLibraryFile(db, mine.id, 'lfr-find'))?.name).toBe('mine.pdf');

    /**
     * The owner is part of the WHERE, so another account's file is
     * indistinguishable from a missing one and the route answers 404 to both —
     * the endpoint never confirms that an id exists.
     */
    expect(await findLibraryFile(db, mine.id, 'lfr-find-other')).toBeUndefined();
  });

  it('answers undefined for an id that is not a Mongo ObjectId, rather than throwing', async () => {
    /**
     * A deliberate behaviour change, recorded because it is one. Mongoose cast
     * `_id: 'not-an-id'` and THREW a `CastError`, which `routes/library.ts`
     * caught and turned into a 500. A `text` primary key just fails to match,
     * so the route now answers 404 — which is the correct answer to "no such
     * file", and is what the same request already returned for a well-formed
     * id belonging to nobody.
     */
    expect(await findLibraryFile(db, 'not-an-object-id', 'lfr-find')).toBeUndefined();
  });

  it('removes only the named file, and only for its owner', async () => {
    const owner = 'lfr-delete';
    const goes = await seed(owner, 'goes.pdf');
    const stays = await seed(owner, 'stays.pdf');

    // Another account cannot delete it — checked BEFORE the successful delete,
    // so a repository ignoring the owner fails here rather than passing both.
    expect(await deleteLibraryFile(db, goes.id, 'lfr-delete-other')).toBe(0);
    expect(await findLibraryFile(db, goes.id, owner)).toBeDefined();

    expect(await deleteLibraryFile(db, goes.id, owner)).toBe(1);
    expect((await listLibraryFiles(db, owner)).map((f) => f.id)).toEqual([stays.id]);
  });

  it('reports ZERO for a file that was already gone', async () => {
    /**
     * Off `result.count`. For a DELETE the returned row set is empty either
     * way, so a repository reading `rows.length` returns a plausible,
     * always-zero answer that this case cannot distinguish alone — which is why
     * the successful delete above asserts `1`.
     */
    expect(await deleteLibraryFile(db, 'no-such-file', 'lfr-delete')).toBe(0);
  });
});
