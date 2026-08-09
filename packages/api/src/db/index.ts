/**
 * The Postgres handle for this service.
 *
 * Built through `createDatabase()` from `@oxyhq/db` rather than a local
 * `drizzle(postgres(url))`, because that is what guarantees the handle carries
 * `DATABASE_CASING` — so what queries REFERENCE matches what the migrations
 * CREATED. Getting that wrong produces `column "oxyUserId" does not exist` at
 * runtime with a schema that looks correct in the editor.
 *
 * ## Postgres is OPTIONAL here, and that is temporary
 *
 * Unlike `packages/integrations`, this service is live on MongoDB and its task
 * definition carries no `DATABASE_URL`. So `connectPostgres()` returns `null`
 * when there is nothing to connect to; every route still runs against Mongo and
 * nothing in the request path reads this handle. It exists so the destination
 * can be built and migrated AHEAD of the call-site port — the same thing #82 did
 * for integrations.
 *
 * When the last domain moves, this becomes required at boot exactly as it is in
 * every other Oxy backend. That is a deliberate step at cutover, not something
 * to slip in: until then a `null` here must mean "not configured", never "not
 * connected yet", or a read would silently fall back to Mongo after its domain
 * had been ported.
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
 * The handle, or `null` when Postgres is not configured.
 *
 * Deliberately NOT the throwing `getDb()` that `packages/integrations` exposes.
 * There, Postgres is the only store and a missing handle is a bug; here an
 * unconfigured deployment is a supported state for the duration of the port, so
 * the caller must decide what to do about it rather than have this module decide
 * by throwing.
 */
export function tryGetDb(): ApiDatabase | null {
  return handle?.db ?? null;
}

/**
 * The handle, or a thrown error — for code that has already established Postgres
 * is required for the path it is on.
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
