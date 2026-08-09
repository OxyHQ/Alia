import { defineConfig } from 'drizzle-kit';
import { DATABASE_CASING } from '@oxyhq/db';

/**
 * drizzle-kit GENERATES the SQL; it never applies it — `src/db/migrate.ts` is
 * the only migrator, because drizzle-kit is a devDependency and cannot be
 * reached from a production image.
 *
 * `casing` comes from `@oxyhq/db` so the DDL this creates and the queries
 * `createDatabase()` builds derive from ONE setting rather than two copies free
 * to disagree.
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: DATABASE_CASING,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
