/**
 * The user's file library: what was uploaded, where it lives, and who owns it.
 *
 * One table, no relations. It is here rather than folded into a neighbouring
 * file because it belongs to no other domain in this schema — the library is
 * reached only through `routes/library.ts`, and nothing else in the service
 * reads it.
 *
 * No TTL index in Mongoose, so no entry in `db/expiryTargets.ts`. Uploaded
 * files are user content and must NOT acquire one by analogy with the
 * short-lived tables elsewhere in this schema.
 */

import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { FILE_CATEGORIES } from '../../domain/library-file.js';
import { checkOneOf } from './columns';

/**
 * One uploaded file.
 *
 * ## `owner_oxy_user_id` is the Oxy account, and Mongoose spells it `owner`
 *
 * This is the one column in the batch whose name a mapping cannot be DERIVED
 * from. Every other table in this schema names the account `oxy_user_id`;
 * `LibraryFile` calls the same thing `owner`, and it is declared
 * `ref: 'User'` — a model this service does not register, per
 * `models/__tests__/retiredModelFiles.test.ts`. A backfill that pairs
 * columns by name would silently leave this one NULL and every file would
 * become unreachable while the copy reported success.
 *
 * So the column states what it holds and the backfill maps `owner` onto it
 * EXPLICITLY. That is the same rule CONVENTIONS.md already applies to
 * collection names — an arbitrary name is not evidence of anything, and a
 * derivation over one is a check that cannot fail.
 *
 * No foreign key: Oxy owns identity. See `lib/oxy-user-hydration.ts`.
 *
 * ## `size` is BYTES, so `bigint`
 *
 * `routes/library.ts:102` writes multer's `file.size`, which is a byte count,
 * not a money amount — the Oxy `bigint` convention applies here for the
 * unrelated reason that `integer` tops out at 2 GB and a single upload can
 * exceed it.
 *
 * **`mode: 'number'` is narrower than it reads, and this was MEASURED rather
 * than assumed.** postgres.js decodes `int8` as a STRING; the mode is applied
 * by drizzle's result mapper, which runs only for a query the QUERY BUILDER
 * constructed. So the same column in the same row reaches JavaScript as a
 * `number` through `db.select(...)` and as a `string` through a raw
 * `db.execute(sql\`select size …\`)` — and `tsc` types both as `number`.
 * `library.pgdb.test.ts` pins both halves.
 *
 * Two consequences: every raw statement in this package's own suite takes the
 * string path, and a repository that mixes builder queries with raw SQL for
 * the parts the builder cannot express gets two types for one column. An
 * AGGREGATE is the same rule with no escape at all — `sum(size)`, the obvious
 * per-user storage total, has no column builder to carry a mode, so it is a
 * string however it is issued. Coerce at that boundary.
 *
 * ## `type` has no CHECK
 *
 * It is a MIME type taken from the upload's own `Content-Type`. The set
 * belongs to IANA and to whatever a client sends, not to this schema — the
 * `subscriptions.status` rule: if the format belongs to somebody else, this
 * schema does not get to close it. `category` is Alia's own three-value
 * grouping and does carry one.
 */
export const libraryFiles = pgTable(
  'library_files',
  {
    id: generatedId(),
    /** Mongoose calls this `owner`. An Oxy account; no foreign key. */
    ownerOxyUserId: text().notNull(),
    name: text().notNull(),
    url: text().notNull(),
    /** The upload's MIME type. No CHECK — see the table comment. */
    type: text().notNull(),
    /** Bytes. See the table comment for why this is `bigint`. */
    size: bigint({ mode: 'number' }).notNull(),
    category: text({ enum: FILE_CATEGORIES as unknown as [string, ...string[]] }).notNull(),
    thumbnail: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Serves `GET /library` — the owner's files, newest first.
    index('library_files_owner_created_at_idx').on(t.ownerOxyUserId, t.createdAt.desc()),
    checkOneOf('library_files_category_check', t.category, FILE_CATEGORIES),
  ],
);
