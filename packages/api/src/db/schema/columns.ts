/**
 * Column and constraint helpers local to this schema.
 *
 * Everything general — `timestamptz`, `createdAt`/`updatedAt`, `generatedId`,
 * `inList` — belongs to `@oxyhq/db` and is imported from there, not re-declared.
 * This file holds only what that package does not own.
 */

import { check, type PgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { inList } from '@oxyhq/db';

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
