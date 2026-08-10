/**
 * Column and constraint helpers local to this schema.
 *
 * Everything general — `timestamptz`, `createdAt`/`updatedAt`, `generatedId`,
 * `inList` — belongs to `@oxyhq/db` and is imported from there, not re-declared.
 * This file holds only what that package does not own.
 */

import { check, customType, type PgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { inList } from '@oxyhq/db';
import { decrypt, encrypt } from '../../lib/crypto-utils.js';

/**
 * `text` that cannot be stored in the clear.
 *
 * The OAuth access and refresh tokens on `integrations` and `connected_accounts`
 * were encrypted in Mongo by FIELD-LEVEL `set: encrypt, get: decrypt` — so
 * encryption was true by CONSTRUCTION on every write, whatever the call site.
 * drizzle has no getter/setter, and porting those columns as plain `text` would
 * quietly demote that guarantee to "wherever whoever writes the repository
 * remembers". Nothing would fail, no test would go red, and the symptom would be
 * third-party OAuth tokens sitting in plaintext until a dump leaked.
 *
 * A `customType` is the only one of the available shapes where "a plaintext
 * token cannot be stored" stays structural rather than remembered: drizzle
 * applies `toDriver` to every insert and update it builds, so there is no
 * spelling of a write through the query builder that skips it.
 *
 * Three things to know before using it:
 *
 *  - **A raw `db.execute(sql\`insert …\`)` bypasses it**, exactly as a raw Mongo
 *    driver write bypassed the Mongoose setter. Parity, not a new hole — but it
 *    means the migration and any hand-written statement must pass ciphertext.
 *  - **The BACKFILL must not double-encrypt.** Mongoose applies `get: decrypt`
 *    on property access (both schemas set `toObject/toJSON: { getters: true }`),
 *    so a backfill reading through Mongoose holds PLAINTEXT and must write it
 *    through drizzle, which encrypts once. Reading ciphertext through the raw
 *    driver and writing it through drizzle encrypts it a SECOND time, and the
 *    row is unrecoverable without knowing it happened.
 *  - **`fromDriver` throws on a value that is not well-formed ciphertext**,
 *    which is a fail-closed read rather than a silent plaintext leak. The tables
 *    start empty, so the only writer of a malformed value would be a hand-written
 *    statement.
 *
 * `crypto-utils.ts` is AES-256-GCM, `iv:authTag:ciphertext` hex, keyed by
 * `TOKEN_ENCRYPTION_KEY` — already synced to `/oxy/alia/TOKEN_ENCRYPTION_KEY`.
 * The key is read lazily, so importing this module without one is fine; only a
 * read or write of such a column needs it.
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => encrypt(value),
  fromDriver: (value) => decrypt(value),
});

/**
 * `CHECK (<column> in (…))`, rendered from the SAME tuple that types the column.
 *
 * `text({ enum })` emits NO DDL — it is a TypeScript narrowing only, so a closed
 * value set written without this beside it looks constrained in the editor and
 * accepts anything in the database. Every such column in this schema states its
 * CHECK explicitly, generated from the tuple rather than retyped, so the two
 * cannot drift.
 *
 * A nullable column passes: `null in (…)` is NULL, and a CHECK rejects only
 * FALSE. That is wanted — an unset optional value is absence, not a violation.
 */
export function checkOneOf(name: string, column: PgColumn, values: readonly string[]) {
  return check(name, sql`${column} in (${sql.raw(inList(values))})`);
}

/**
 * `CHECK (<array column> <@ ARRAY[…])` — every member is in the tuple.
 *
 * The scalar `checkOneOf` cannot express this: `col in (…)` on an array column
 * compares the whole array to each scalar and is false for everything. Postgres
 * spells "all members are drawn from this set" as containment, `<@`.
 *
 * An EMPTY array is contained by every set, so this permits `{}`. That is the
 * right split of responsibilities — "at least one category" is a cardinality
 * rule, enforced beside this one, not something a membership CHECK should be
 * quietly doing as well.
 */
export function checkArrayWithin(name: string, column: PgColumn, values: readonly string[]) {
  return check(
    name,
    sql`${column} <@ ARRAY[${sql.raw(inList(values))}]::text[]`,
  );
}
