/**
 * The user's file library, on Postgres.
 *
 * One table, no relations, reached only through `routes/library.ts`.
 *
 * ## `owner` becomes `owner_oxy_user_id`, and the mapping is EXPLICIT
 *
 * Every other table in this schema names the account `oxy_user_id`; the
 * Mongoose model called it `owner`. `db/schema/library.ts` states why the
 * column says what it holds — a pairing derived from NAMES would leave it null
 * and make every file unreachable while reporting success. So the mapping is
 * written out here, once, at the only boundary that performs it.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { FileCategory } from '../../domain/library-file.js';
import type { ApiDatabase } from '../index';
import { libraryFiles } from '../schema/library';

/** A stored library file, as this repository reads it. */
export interface LibraryFileRow {
  readonly id: string;
  readonly ownerOxyUserId: string;
  readonly name: string;
  readonly url: string;
  readonly type: string;
  readonly size: number;
  readonly category: string;
  readonly thumbnail: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What `routes/library.ts` puts on the wire.
 *
 * ## `_id` is a versioned contract, not a leak
 *
 * `packages/app/lib/stores/library-store.ts:9` declares `_id: string` and `:93`
 * filters the store on `file._id`. That is a SHIPPED mobile build which cannot
 * be recalled, so the field is served from the Postgres `id` rather than
 * renamed. It retires when no supported client reads it.
 *
 * `thumbnail` is omitted rather than sent as `null`: Mongo's `lean()` left an
 * unset optional field off the document entirely, and a client distinguishing
 * "absent" from "null" would see a change that is invisible from here.
 */
export interface LibraryFileResponse {
  readonly _id: string;
  readonly name: string;
  readonly url: string;
  readonly type: string;
  readonly size: number;
  readonly category: string;
  readonly thumbnail?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Project a stored row onto the wire shape.
 *
 * ## `size` is where this port could go wrong silently
 *
 * `size` is `bigint({ mode: 'number' })`. The mode is applied by drizzle's
 * result mapper, which runs only for a query the QUERY BUILDER constructed — a
 * raw `db.execute` returns the same column as a STRING, and `tsc` types both as
 * `number`. A string `size` would serialise to JSON as `"12345"` and reach a
 * client that declares `size: number`, where it would format as a filename-sized
 * number and never throw. Every read here goes through the builder, and
 * `library.pgdb.test.ts` asserts the `typeof` on a real row.
 */
export function toLibraryFileResponse(row: LibraryFileRow): LibraryFileResponse {
  return {
    _id: row.id,
    name: row.name,
    url: row.url,
    type: row.type,
    size: row.size,
    category: row.category,
    ...(row.thumbnail === null ? {} : { thumbnail: row.thumbnail }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * This owner's files, newest first, optionally narrowed to one category.
 *
 * `category` is applied as a filter when supplied and ignored when not — the
 * route validates it against `FILE_CATEGORIES` before calling, and an
 * unrecognised value there means "no filter", exactly as the Mongo version's
 * `includes` check decided.
 */
export async function listLibraryFiles(
  db: ApiDatabase,
  ownerOxyUserId: string,
  category?: FileCategory,
): Promise<LibraryFileRow[]> {
  return db
    .select()
    .from(libraryFiles)
    .where(
      category
        ? and(eq(libraryFiles.ownerOxyUserId, ownerOxyUserId), eq(libraryFiles.category, category))
        : eq(libraryFiles.ownerOxyUserId, ownerOxyUserId),
    )
    .orderBy(desc(libraryFiles.createdAt));
}

/**
 * One file, scoped to its owner.
 *
 * The owner is part of the WHERE rather than checked afterwards, so another
 * account's file is indistinguishable from a missing one — the route answers
 * 404 to both, which is what it did before and what stops the endpoint
 * confirming that an id exists.
 */
export async function findLibraryFile(
  db: ApiDatabase,
  id: string,
  ownerOxyUserId: string,
): Promise<LibraryFileRow | undefined> {
  const [row] = await db
    .select()
    .from(libraryFiles)
    .where(and(eq(libraryFiles.id, id), eq(libraryFiles.ownerOxyUserId, ownerOxyUserId)));
  return row;
}

export interface NewLibraryFile {
  readonly ownerOxyUserId: string;
  readonly name: string;
  readonly url: string;
  readonly type: string;
  readonly size: number;
  readonly category: FileCategory;
  readonly thumbnail?: string;
}

/** Record an uploaded file, returning the stored row. */
export async function createLibraryFile(
  db: ApiDatabase,
  input: NewLibraryFile,
): Promise<LibraryFileRow> {
  const [row] = await db
    .insert(libraryFiles)
    .values({
      ownerOxyUserId: input.ownerOxyUserId,
      name: input.name,
      url: input.url,
      type: input.type,
      size: input.size,
      category: input.category,
      thumbnail: input.thumbnail ?? null,
    })
    .returning();
  if (!row) throw new Error('library file insert returned no row');
  return row;
}

/**
 * Remove one file, scoped to its owner.
 *
 * Reports rows removed off `count`, never `rows.length` — for a DELETE the
 * returned row set is empty either way, so the wrong reading is a plausible,
 * always-zero answer. The route has already read the row to delete the S3
 * object, so a zero here means it went between the two statements.
 */
export async function deleteLibraryFile(
  db: ApiDatabase,
  id: string,
  ownerOxyUserId: string,
): Promise<number> {
  const result = await db
    .delete(libraryFiles)
    .where(and(eq(libraryFiles.id, id), eq(libraryFiles.ownerOxyUserId, ownerOxyUserId)));
  return result.count;
}
