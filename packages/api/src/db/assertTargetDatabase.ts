/**
 * Refuse to act unless the connection is on the database the caller named.
 *
 * A connection string and a `--target-database` flag are two statements of the
 * same fact, and when they disagree the loser is silent: the run reports success
 * over a database nobody meant to touch. That is not hypothetical — a stale port
 * in a test recipe pointed a 28-migration run at an unrelated project's Postgres,
 * and only a password mismatch stopped it.
 *
 * Shared rather than copied because two scripts need it, and a guard that exists
 * in two places is a guard that will exist in one.
 */

import { sql } from 'drizzle-orm';
import { getDb } from './index.js';

export async function assertTargetDatabase(expected: string): Promise<void> {
  const rows = await getDb().execute<{ current_database: string }>(sql`select current_database()`);
  const actual = rows[0]?.current_database;
  if (actual !== expected) {
    throw new Error(
      `refusing to act: --target-database=${expected} but the connection is on ${actual ?? 'an unreadable database'}`,
    );
  }
}
