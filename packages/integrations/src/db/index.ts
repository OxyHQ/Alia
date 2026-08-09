/**
 * The Postgres handle for this service.
 *
 * Built through `createDatabase()` from `@oxyhq/db` rather than a local
 * `drizzle(postgres(url))`, because that is what guarantees the handle carries
 * `DATABASE_CASING` — so what queries REFERENCE matches what the migrations
 * CREATED. Getting that wrong produces `column "sessionId" does not exist` at
 * runtime with a schema that looks correct in the editor.
 */

import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import type postgres from 'postgres';
import * as schema from './schema';

export type IntegrationsDatabase = OxyDatabase<typeof schema>;

let handle: { db: IntegrationsDatabase; client: postgres.Sql } | null = null;

/**
 * Open the pool. Called once from `main()`; not lazy, so a bad `DATABASE_URL`
 * fails at boot rather than on the first request that happens to touch it.
 */
export function connectPostgres(databaseUrl: string): IntegrationsDatabase {
  if (handle) return handle.db;
  handle = createDatabase({ databaseUrl, schema });
  return handle.db;
}

export function getDb(): IntegrationsDatabase {
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
