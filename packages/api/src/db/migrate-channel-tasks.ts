#!/usr/bin/env bun
import { closePostgres, connectPostgres } from './index.js';
import { migrateChannelTaskAuthority } from './integrations/migrateChannelTaskAuthority.js';

const databaseUrl = process.env.DATABASE_URL;
const target = process.argv
  .find((arg) => arg.startsWith('--target-database='))
  ?.slice('--target-database='.length);
if (!databaseUrl || !target || new URL(databaseUrl).pathname.slice(1) !== target)
  throw new Error('DATABASE_URL and matching explicit --target-database are required');
const db = connectPostgres(databaseUrl);
if (!db) throw new Error('Postgres is required');
try {
  // Dry-run by default. Counts only: no ids, token material or raw provider errors.
  console.log(
    JSON.stringify(
      await migrateChannelTaskAuthority(db, { apply: process.argv.includes('--apply') }),
    ),
  );
} finally {
  await closePostgres();
}
