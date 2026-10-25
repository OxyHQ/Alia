#!/usr/bin/env bun
import { closePostgres, connectPostgres } from './index.js';
import {
  migrateChannelTaskAuthority,
  channelTaskAuthorityInventory,
} from './integrations/migrateChannelTaskAuthority.js';

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
  const result = await migrateChannelTaskAuthority(db, { apply: process.argv.includes('--apply') });
  console.log(JSON.stringify({ ...result, unresolved: await channelTaskAuthorityInventory(db) }));
  if (result.retry > 0) throw new Error('Channel authority reconciliation requires retry');
} finally {
  await closePostgres();
}
