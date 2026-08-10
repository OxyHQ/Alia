import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isCheckViolation, constraintNameOf } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { libraryFiles } from '../schema/library';
import { FILE_CATEGORIES } from '../../models/library-file.js';

/**
 * `library_files`, against a REAL server.
 *
 * Two properties are under test and each needed a fixture chosen so that the
 * RIGHT column type and the WRONG one give different answers — a 100-byte file
 * and a lowercase category would pass under either.
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

const insertFile = (id: string, category: string, size: number) => db.execute(sql`
  insert into ${libraryFiles} (id, owner_oxy_user_id, name, url, type, size, category)
  values (${id}, 'lib-owner', 'f.bin', 'https://example.test/f.bin', 'application/octet-stream', ${size}, ${category})
`);

describe('the category CHECK is enforced by the DATABASE, not just the editor', () => {
  it('refuses a category outside the tuple, naming its own constraint', async () => {
    // `text({ enum })` emits no DDL, so this is what proves the CHECK shipped.
    await expect(insertFile('lib-bad', 'videos', 10)).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('library_files_category_check');
      return true;
    });
  });

  it('accepts every value that IS in the tuple', async () => {
    for (const category of FILE_CATEGORIES) {
      await insertFile(`lib-ok-${category}`, category, 10);
    }
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${libraryFiles} where id like 'lib-ok-%'`,
    );
    // Rendered from the same tuple the column is typed from, so adding a
    // category without widening the CHECK fails here rather than in production.
    expect(rows[0]?.n).toBe(String(FILE_CATEGORIES.length));
  });
});

describe('size is a byte count that does not fit in an integer', () => {
  /**
   * The fixture is the whole point: `integer` tops out at 2,147,483,647, so a
   * small file is stored identically by both types and a test using one would
   * measure nothing. A 3 GB upload is the input shape that makes `integer` and
   * `bigint` disagree — under `integer` this insert fails outright.
   */
  const THREE_GIGABYTES = 3 * 1024 * 1024 * 1024;

  it('stores a size past the 32-bit ceiling and reads it back exactly', async () => {
    await insertFile('lib-big', 'other', THREE_GIGABYTES);

    const [row] = await db
      .select({ size: libraryFiles.size })
      .from(libraryFiles)
      .where(eq(libraryFiles.id, 'lib-big'));
    expect(row?.size).toBe(THREE_GIGABYTES);
  });

  it('reaches JavaScript as a STRING through a raw statement and a NUMBER through the query builder', async () => {
    await insertFile('lib-both', 'other', THREE_GIGABYTES);

    const [raw] = await db.execute<{ size: unknown }>(
      sql`select size from ${libraryFiles} where id = 'lib-both'`,
    );
    const [built] = await db
      .select({ size: libraryFiles.size })
      .from(libraryFiles)
      .where(eq(libraryFiles.id, 'lib-both'));

    /**
     * Measured, and NOT what "the column carries `mode: 'number'`" suggests on
     * its own: the mode is applied by drizzle's result mapper, which only runs
     * for a query the BUILDER constructed. A raw `sql` statement returns
     * whatever postgres.js decoded, and it decodes `int8` as a string.
     *
     * That matters here because every other `*.pgdb.test.ts` in this suite —
     * and any repository reaching for raw SQL to express something the builder
     * cannot — takes the raw path. Same column, same row, two JavaScript types,
     * and `tsc` types both as `number`.
     */
    expect(typeof raw?.size).toBe('string');
    expect(typeof built?.size).toBe('number');
    expect(Number(raw?.size)).toBe(built?.size);
  });

  it('sums to a STRING, which is the trap the column comment warns about', async () => {
    await db.execute(sql`delete from ${libraryFiles} where owner_oxy_user_id = 'lib-sum-owner'`);
    await db.execute(sql`
      insert into ${libraryFiles} (id, owner_oxy_user_id, name, url, type, size, category) values
        ('lib-sum-1', 'lib-sum-owner', 'a', 'u', 't', ${THREE_GIGABYTES}, 'other'),
        ('lib-sum-2', 'lib-sum-owner', 'b', 'u', 't', ${THREE_GIGABYTES}, 'other')
    `);

    const [row] = await db.execute<{ total: unknown }>(
      sql`select sum(size) as total from ${libraryFiles} where owner_oxy_user_id = 'lib-sum-owner'`,
    );

    /**
     * An aggregate has no column builder to carry `mode: 'number'`, so
     * `sum(bigint)` returns `numeric` and postgres.js hands it back as a string
     * — while TypeScript would happily type it `number`. This assertion is what
     * makes the storage-total reader in the column comment a known cost rather
     * than a surprise; if the driver ever stops doing this, it goes red and the
     * comment gets corrected.
     */
    expect(typeof row?.total).toBe('string');
    expect(Number(row?.total)).toBe(THREE_GIGABYTES * 2);
  });
});
