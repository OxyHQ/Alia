/**
 * One-shot purge: strip persisted user IPs from historical documents.
 *
 * Privacy mandate (ecosystem-wide): no user IPs at rest — not in MongoDB,
 * logs, or DTOs. The schema writers were already removed; this script erases
 * the field from documents written before that change.
 *
 *   - `ipAddress` on every `apikeyusages` document
 *   - `ip` on every `adminaudits` document
 *
 * Both collections live in the shared `alia-<env>` database (the gateway and
 * the API share it). Safe to run multiple times — a re-run is a no-op once the
 * fields are gone.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx src/scripts/purge-ip-fields.ts   # count only, no writes
 *   npx tsx src/scripts/purge-ip-fields.ts             # perform the purge
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DB_NAME = `alia-${NODE_ENV}`;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const TARGETS = [
  { collection: 'apikeyusages', field: 'ipAddress' },
  { collection: 'adminaudits', field: 'ip' },
] as const;

async function purge() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  console.log(`Connecting to MongoDB: ${DB_NAME} (${DRY_RUN ? 'DRY RUN — no writes' : 'LIVE — will unset fields'})...`);
  await mongoose.connect(MONGODB_URI, { dbName: DB_NAME });

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection has no database handle');
  }

  for (const { collection, field } of TARGETS) {
    const filter = { [field]: { $exists: true } };
    const affected = await db.collection(collection).countDocuments(filter);

    if (DRY_RUN) {
      console.log(`[dry-run] ${collection}.${field}: ${affected} document(s) would be unset`);
      continue;
    }

    const result = await db.collection(collection).updateMany(filter, { $unset: { [field]: '' } });
    console.log(`✓ ${collection}.${field}: matched ${result.matchedCount}, unset ${result.modifiedCount} (had ${affected})`);
  }

  console.log(`\nDone.${DRY_RUN ? ' (dry run — nothing written)' : ''}`);
  await mongoose.disconnect();
}

purge().catch((err) => {
  console.error('Purge failed:', err);
  process.exit(1);
});
