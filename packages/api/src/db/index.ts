/**
 * The Postgres handle for this service.
 *
 * Built through `createDatabase()` from `@oxyhq/db` rather than a local
 * `drizzle(postgres(url))`, because that is what guarantees the handle carries
 * `DATABASE_CASING` — so what queries REFERENCE matches what the migrations
 * CREATED. Getting that wrong produces `column "oxyUserId" does not exist` at
 * runtime with a schema that looks correct in the editor.
 *
 * ## Postgres is REQUIRED
 *
 * `oxy-alia:28` carries `DATABASE_URL`, `index.ts` connects before the socket
 * opens, and a missing or unusable connection string exits the process rather
 * than starting a service that answers some routes and 500s the rest.
 *
 * `connectPostgres()` still returns `null` for an unconfigured URL rather than
 * throwing, because the decision "this is fatal" belongs to the application's
 * boot, not to the module that opens a pool — the test suite legitimately calls
 * it and wants the answer, not an exception. What is gone is any code path that
 * treats `null` as a state to CARRY: there is no `tryGetDb()` any more, so a
 * caller cannot quietly no-op when the database is absent.
 *
 * Mongoose call sites remain until the last domain is ported. They do not read
 * this handle and this handle knows nothing about them; the two stores are
 * simply both open for the duration, and `lib/db.ts` goes away with the last of
 * them.
 */

import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import type postgres from 'postgres';
import * as schema from './schema';

export type ApiDatabase = OxyDatabase<typeof schema>;

let handle: { db: ApiDatabase; client: postgres.Sql } | null = null;

/**
 * Open the pool if a `DATABASE_URL` is configured.
 *
 * Not lazy: a bad connection string fails at boot rather than on the first
 * request that happens to touch it. Returns `null` when unconfigured, so the
 * caller logs that plainly at startup instead of discovering it later.
 */
export function connectPostgres(databaseUrl: string | undefined): ApiDatabase | null {
  if (handle) return handle.db;
  if (!databaseUrl) return null;
  handle = createDatabase({ databaseUrl, schema });
  return handle.db;
}

/**
 * The handle, or a thrown error.
 *
 * The only accessor. A `tryGetDb()` returning `null` used to exist beside it,
 * and its single caller answered the null by returning early — which is the
 * permissive-direction failure in miniature: with Postgres required at boot the
 * null is unreachable, and while it WAS reachable it turned "the database is
 * missing" into "there was nothing to do". Throwing is what keeps those apart.
 */
export function getDb(): ApiDatabase {
  if (!handle) {
    throw new Error('Postgres is not connected — call connectPostgres() during startup');
  }
  return handle.db;
}

export async function closePostgres(): Promise<void> {
  if (!handle) return;
  await handle.client.end();
  handle = null;
}

export { schema };
