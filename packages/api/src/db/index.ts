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
 * This said "Mongoose call sites remain until the last domain is ported". They
 * do not: `lib/db.ts` went with the boot path's `connectDB()`, and this is the
 * service's only store. `db/__tests__/bootWiring.test.ts` walks the import graph
 * from `src/index.ts` and asserts the Mongo driver is unreachable from it.
 */

import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import type postgres from 'postgres';
import * as schema from './schema';

export type ApiDatabase = OxyDatabase<typeof schema>;

/**
 * A drizzle transaction handle, or the root connection.
 *
 * Declared here beside `ApiDatabase` rather than in one of the repositories that
 * need it, because it is a property of this handle and three repositories now
 * take it. Derived from `transaction`'s own callback parameter so it cannot drift
 * from whatever drizzle actually hands out.
 *
 * The two are NOT interchangeable, and the difference is observable at runtime:
 * only the transaction handle carries `rollback`. `requireTransaction` in
 * `moderation/outboxRepository.ts` is built on exactly that, because a type
 * cannot tell the two apart once both are widened to this union — which is the
 * whole reason the union needs a runtime guard at the one place it matters.
 */
export type Executor = ApiDatabase | Parameters<Parameters<ApiDatabase['transaction']>[0]>[0];

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
