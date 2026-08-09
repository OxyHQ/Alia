/**
 * Creates ONE throwaway, fully-migrated Postgres database for the whole suite
 * run and drops it afterwards, publishing its URL as `DATABASE_URL` for the
 * tests.
 *
 * A real server rather than a mock, because the properties worth testing here do
 * not exist without one: a CHECK constraint, a partial unique index, an
 * `ON DELETE CASCADE`, and an `ON CONFLICT` upsert are all enforced by Postgres
 * and have no mocked counterpart. A mocked `insert` accepts any statement,
 * including one the server would reject outright — which is exactly the class of
 * bug a port introduces.
 */

import type { TestProject } from 'vitest/node';
import { setUpTestDatabase, type TestDatabaseHandle } from './src/db/testDatabase';

let handle: TestDatabaseHandle | null = null;

export async function setup(project: TestProject): Promise<void> {
  handle = await setUpTestDatabase();
  process.env.DATABASE_URL = handle.databaseUrl;
  project.provide('databaseUrl', handle.databaseUrl);
}

export async function teardown(): Promise<void> {
  if (!handle) return;
  await handle.drop();
  handle = null;
}

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}
