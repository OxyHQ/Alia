/**
 * The user's file library, on Postgres.
 *
 * One table, no relations, reached only through `routes/library.ts`.
 *
 * ## `owner` becomes `owner_oxy_user_id`, and the mapping is EXPLICIT
 *
 * Every other table in this schema names the account `oxy_user_id`; the
 * API calls it `owner`. `db/schema/library.ts` states why the
 * column says what it holds — a pairing derived from NAMES would leave it null
 * and make every file unreachable while reporting success. So the mapping is
 * written out here, once, at the only boundary that performs it.
 */

import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import type { FileCategory } from '../../domain/library-file.js';
import { storedLocator } from '../../domain/oxy-files.js';
import type { ApiDatabase } from '../index';
import { markLegacyObjectsMaybeGarbage, recordFileReferences } from '../files/oxyFileRepository';
import { libraryFiles } from '../schema/library';

/** A stored library file, as this repository reads it. */
export interface LibraryFileRow {
  readonly id: string;
  readonly ownerOxyUserId: string;
  readonly name: string;
  /** The legacy object KEY, or NULL for a file stored only in Oxy Files. */
  readonly url: string | null;
  /** The person's Oxy file (oxy ADR 0041). Read before `url`. */
  readonly oxyFileId: string | null;
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
 * `packages/app/src/features/library/runtime/library-store.ts:9` declares `_id: string` and `:93`
 * filters the store on `file._id`. That is a SHIPPED mobile build which cannot
 * be recalled, so the field is served from the Postgres `id` rather than
 * renamed. It retires when no supported client reads it.
 *
 * `thumbnail` is omitted rather than sent as `null`: an unset optional field is
 * absent from the response, and a client distinguishing "absent" from "null"
 * would see a change that is invisible from here.
 */
export interface LibraryFileResponse {
  readonly _id: string;
  readonly name: string;
  /**
   * Where the file is, as a stored LOCATOR (`storedLocator`) — never sent as
   * is: `routes/library.ts` turns it into a playback link.
   */
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
    // The CHECK keeps one of the two set, so a locator always exists.
    url: storedLocator(row.url, row.oxyFileId) ?? '',
    type: row.type,
    size: row.size,
    category: row.category,
    ...(thumbnailOf(row) === null ? {} : { thumbnail: thumbnailOf(row) as string }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** An image is its own thumbnail — its legacy key, or its Oxy file once it has no other. */
function thumbnailOf(row: LibraryFileRow): string | null {
  if (row.thumbnail !== null) return row.thumbnail;
  if (row.category === 'images' && row.oxyFileId !== null)
    return storedLocator(null, row.oxyFileId);
  return null;
}

/**
 * This owner's files, newest first, optionally narrowed to one category.
 *
 * `category` is applied as a filter when supplied and ignored when not — the
 * route validates it against `FILE_CATEGORIES` before calling, and an
 * unrecognised value there means "no filter".
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
  /** The legacy object key, when the bytes went to Alia's bucket. */
  readonly url: string | null;
  /** The person's Oxy file, when the bytes went to Oxy Files. */
  readonly oxyFileId?: string | null;
  readonly type: string;
  readonly size: number;
  readonly category: FileCategory;
  readonly thumbnail?: string;
}

/**
 * Record an uploaded file, returning the stored row — and, in the same
 * transaction, that Alia uses its Oxy file, so the use exists exactly when the
 * row does.
 */
export async function createLibraryFile(
  db: ApiDatabase,
  input: NewLibraryFile,
): Promise<LibraryFileRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(libraryFiles)
      .values({
        ownerOxyUserId: input.ownerOxyUserId,
        name: input.name,
        url: input.url,
        oxyFileId: input.oxyFileId ?? null,
        type: input.type,
        size: input.size,
        category: input.category,
        thumbnail: input.thumbnail ?? null,
      })
      .returning();
    if (!row) throw new Error('library file insert returned no row');
    if (row.oxyFileId !== null) {
      await recordFileReferences(tx, [
        { fileId: row.oxyFileId, entityType: 'library_file', entityId: row.id, desired: 'present' },
      ]);
    }
    return row;
  });
}

/**
 * The migration's write: a legacy file now also lives in the person's Oxy file.
 * Only while it has none yet; the legacy key stays as the dual-read fallback.
 */
export async function adoptLibraryOxyFile(
  db: ApiDatabase,
  id: string,
  fileId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(libraryFiles)
      .set({ oxyFileId: fileId })
      .where(and(eq(libraryFiles.id, id), isNull(libraryFiles.oxyFileId)))
      .returning({ id: libraryFiles.id });
    if (!row) return false;
    await recordFileReferences(tx, [
      { fileId, entityType: 'library_file', entityId: id, desired: 'present' },
    ]);
    return true;
  });
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
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(libraryFiles)
      .where(and(eq(libraryFiles.id, id), eq(libraryFiles.ownerOxyUserId, ownerOxyUserId)))
      .returning({
        id: libraryFiles.id,
        url: libraryFiles.url,
        thumbnail: libraryFiles.thumbnail,
        oxyFileId: libraryFiles.oxyFileId,
      });
    // What the row named goes with it, in this transaction: the person's Oxy
    // file loses Alia's reference (it stays theirs, "not in use", never deleted
    // behind their back — ADR 0041 D5), and a legacy object becomes garbage the
    // collector deletes. Before, the route deleted the object first with a call
    // that swallowed its own failure, so a failed delete leaked it for good.
    for (const row of removed) {
      if (row.oxyFileId !== null) {
        await recordFileReferences(tx, [
          {
            fileId: row.oxyFileId,
            entityType: 'library_file',
            entityId: row.id,
            desired: 'absent',
          },
        ]);
      }
      const keys = [row.url, row.thumbnail].filter((key): key is string => key !== null);
      await markLegacyObjectsMaybeGarbage(
        tx,
        [...new Set(keys)].map((key) => ({ key, kind: 'library_file' as const })),
        0,
      );
    }
    return removed.length;
  });
}

/** Legacy files with no Oxy copy yet, by id after `afterId` — the migration's work list. */
export async function listLibraryFilesOnLegacyStorage(
  db: ApiDatabase,
  afterId: string,
  limit: number,
): Promise<LibraryFileRow[]> {
  return db
    .select()
    .from(libraryFiles)
    .where(and(isNull(libraryFiles.oxyFileId), gt(libraryFiles.id, afterId)))
    .orderBy(asc(libraryFiles.id))
    .limit(limit);
}

/** A file whose Oxy copy Oxy says is gone (deleted or taken down): the row goes too. */
export async function deleteLibraryFilesByOxyFile(
  db: ApiDatabase,
  fileId: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(libraryFiles)
      .where(eq(libraryFiles.oxyFileId, fileId))
      .returning({ id: libraryFiles.id, url: libraryFiles.url, thumbnail: libraryFiles.thumbnail });
    for (const row of removed) {
      await recordFileReferences(tx, [
        { fileId, entityType: 'library_file', entityId: row.id, desired: 'absent' },
      ]);
      const keys = [row.url, row.thumbnail].filter((key): key is string => key !== null);
      await markLegacyObjectsMaybeGarbage(
        tx,
        [...new Set(keys)].map((key) => ({ key, kind: 'library_file' as const })),
        0,
      );
    }
    return removed.length;
  });
}
