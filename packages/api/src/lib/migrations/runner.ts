/**
 * Lightweight MongoDB Migration Runner
 *
 * Tracks applied migrations in a `_migrations` collection.
 * Migration files live in this directory and export { up, down, description }.
 * Run on startup via `runPendingMigrations()` — idempotent and safe for multi-instance.
 */

import mongoose from 'mongoose';
import { log } from '../logger.js';

export interface Migration {
  up: () => Promise<void>;
  down?: () => Promise<void>;
  description: string;
}

interface MigrationRecord {
  name: string;
  appliedAt: Date;
  description: string;
}

interface MigrationLock {
  _id: string;
  locked: boolean;
  lockedAt?: Date;
}

const COLLECTION = '_migrations';

/**
 * Get or create the migrations collection.
 */
async function getMigrationCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB not connected');
  return db.collection<MigrationRecord>(COLLECTION);
}

/**
 * Check if a migration has already been applied.
 */
async function isApplied(name: string): Promise<boolean> {
  const col = await getMigrationCollection();
  const doc = await col.findOne({ name });
  return !!doc;
}

/**
 * Record a migration as applied.
 */
async function recordMigration(name: string, description: string): Promise<void> {
  const col = await getMigrationCollection();
  await col.insertOne({ name, appliedAt: new Date(), description });
}

/**
 * Registry of all migrations in order.
 * Add new migrations here. Order matters — they run sequentially.
 */
const MIGRATIONS: Array<{ name: string; load: () => Promise<Migration> }> = [
  { name: '001-restructure-memories-title-summary-type', load: () => import('./001-restructure-memories-title-summary-type.js') },
];

/**
 * Run all pending migrations. Safe to call on every startup.
 * Uses a lightweight advisory lock via findOneAndUpdate to prevent
 * concurrent execution across multiple instances.
 */
export async function runPendingMigrations(): Promise<void> {
  if (MIGRATIONS.length === 0) {
    log.general.info('No migrations registered');
    return;
  }

  // Simple advisory lock: try to claim the lock
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB not connected');
  const lockCol = db.collection<MigrationLock>('_migration_lock');
  const lockResult = await lockCol.findOneAndUpdate(
    { _id: 'migration_lock', locked: false },
    { $set: { locked: true, lockedAt: new Date() } },
    { upsert: true, returnDocument: 'after' },
  ).catch(() => null);

  if (!lockResult || !lockResult.locked) {
    log.general.info('Migration lock held by another instance, skipping');
    return;
  }

  try {
    let applied = 0;

    for (const entry of MIGRATIONS) {
      if (await isApplied(entry.name)) {
        continue;
      }

      log.general.info({ migration: entry.name }, 'Running migration...');

      try {
        const migration = await entry.load();
        await migration.up();
        await recordMigration(entry.name, migration.description);
        applied++;
        log.general.info({ migration: entry.name }, 'Migration applied successfully');
      } catch (error) {
        log.general.error({ err: error, migration: entry.name }, 'Migration failed');
        throw error; // Stop on first failure
      }
    }

    if (applied > 0) {
      log.general.info({ applied, total: MIGRATIONS.length }, 'Migrations complete');
    }
  } finally {
    // Release the lock
    await lockCol.updateOne(
      { _id: 'migration_lock' },
      { $set: { locked: false } },
    ).catch(() => {});
  }
}

/**
 * List all migrations and their status.
 */
export async function listMigrations(): Promise<Array<{ name: string; applied: boolean; appliedAt?: Date }>> {
  const col = await getMigrationCollection();
  const records = await col.find({}).toArray();
  const appliedMap = new Map(records.map(r => [r.name, r.appliedAt]));

  return MIGRATIONS.map(m => ({
    name: m.name,
    applied: appliedMap.has(m.name),
    appliedAt: appliedMap.get(m.name),
  }));
}
