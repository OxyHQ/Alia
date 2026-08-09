/**
 * A throwaway, fully-migrated Postgres database per suite run.
 *
 * `@oxyhq/db/testing` owns the create/drop mechanics, including the generated
 * name (`oxydb_test_<16 hex>`) and the pattern `dropTestDatabase` refuses to
 * drop outside of — which is what stops a stray connection string turning
 * teardown into `DROP DATABASE alia`.
 *
 * ## Why the migration shells out instead of calling `runMigrations` in-process
 *
 * `createTestDatabase` takes `migrate` as a callback precisely so a caller can
 * pass `(url) => runMigrations({ … })`, and that would be one fewer moving part.
 * It is deliberately not what happens here.
 *
 * A second, in-test composition of `runMigrations` is a second set of options —
 * its own migrations folder, its own extension list, its own phase — free to
 * drift from `src/db/migrate.ts` with nothing to notice. The drift is invisible
 * in exactly the direction that matters: the suite keeps passing against a
 * correctly migrated database while the script an operator actually runs is
 * broken. Shelling out to the real entrypoint means the harness exercises the
 * same argument parsing, the same `--target-database` guard and the same phase
 * enforcement that dev and production get. The cost is one subprocess per run.
 *
 * `--phase=all` because a throwaway database has no previous image to protect:
 * the pre/post split exists to sequence a rollout, and there is no rollout here.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '@oxyhq/db/testing';

const PACKAGE_ROOT = join(__dirname, '..', '..');
const MIGRATE_SCRIPT = join(PACKAGE_ROOT, 'src', 'db', 'migrate.ts');

/**
 * The server the throwaway database is created ON. `TEST_DATABASE_URL` first so
 * a developer can point the suite at a scratch server without touching the
 * `DATABASE_URL` their app uses.
 */
function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL (or DATABASE_URL) must point at a Postgres server for the test suite. ' +
        'Run `docker compose -f docker-compose.postgres.yml up -d` and use the URL in that file.',
    );
  }
  return url;
}

/**
 * The database a connection string points at — the URL's own pathname.
 *
 * Needed because `--target-database` is mandatory in this service's migrate
 * entrypoint while `createTestDatabase` generates the name itself and hands back
 * only a URL. Note this is the ONE place deriving the target from the URL is
 * legitimate: the guard exists to catch a `DATABASE_URL` pointing somewhere
 * unexpected, and here the URL was produced moments ago by the harness itself,
 * so there is no independent expectation for it to disagree with. Anywhere else,
 * deriving it from the URL would check the URL against itself.
 */
function databaseNameOf(databaseUrl: string): string {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!name) throw new Error(`No database name in test connection string: ${databaseUrl}`);
  return name;
}

/** Run the REAL migrate entrypoint against `databaseUrl`, exactly as an operator would. */
function migrate(databaseUrl: string): Promise<void> {
  const databaseName = databaseNameOf(databaseUrl);
  return new Promise((resolve, reject) => {
    const child = spawn(
      'bun',
      [MIGRATE_SCRIPT, `--target-database=${databaseName}`, '--phase=all'],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Migration failed (exit ${String(code)}):\n${output}`));
    });
  });
}

export interface TestDatabaseHandle {
  readonly databaseUrl: string;
  readonly databaseName: string;
  drop(): Promise<void>;
}

export async function setUpTestDatabase(): Promise<TestDatabaseHandle> {
  const databaseUrl = await createTestDatabase({ adminUrl: adminUrl(), migrate });
  return {
    databaseUrl,
    databaseName: databaseNameOf(databaseUrl),
    drop: () => dropTestDatabase(databaseUrl),
  };
}
