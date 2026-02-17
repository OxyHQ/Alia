#!/usr/bin/env npx tsx
/**
 * Data Migration Script: alia-production → alia-providers-api-production
 *
 * Copies all provider-related collections from the main API's database
 * to the new providers API's database.
 *
 * Usage:
 *   MONGODB_URI=mongodb+srv://... npx tsx scripts/migrate-providers-data.ts
 *
 * Options:
 *   --dry-run    Show what would be copied without actually copying
 *   --source-db  Source database name (default: alia-production)
 *   --target-db  Target database name (default: alia-providers-api-production)
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Error: MONGODB_URI environment variable is required');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sourceDb = args.find(a => a.startsWith('--source-db='))?.split('=')[1] || 'alia-production';
const targetDb = args.find(a => a.startsWith('--target-db='))?.split('=')[1] || 'alia-providers-api-production';

const COLLECTIONS = [
  'providerkeys',
  'modelconfigs',
  'aliamodels',
  'plans',
  'creditpackages',
  'features',
  'planfeatures',
  'apiusages',
  'fallbackevents',
  'providerhealths',
];

async function migrate() {
  console.log(`\nMigrating provider data:`);
  console.log(`  Source: ${sourceDb}`);
  console.log(`  Target: ${targetDb}`);
  console.log(`  Dry run: ${dryRun}\n`);

  const conn = await mongoose.createConnection(MONGODB_URI!).asPromise();

  const source = conn.useDb(sourceDb);
  const target = conn.useDb(targetDb);

  for (const collName of COLLECTIONS) {
    const sourceCol = source.collection(collName);
    const count = await sourceCol.countDocuments();
    console.log(`  ${collName}: ${count} documents`);

    if (dryRun || count === 0) continue;

    const targetCol = target.collection(collName);
    const existingCount = await targetCol.countDocuments();

    if (existingCount > 0) {
      console.log(`    ⚠ Target already has ${existingCount} docs — skipping (drop manually to re-migrate)`);
      continue;
    }

    const docs = await sourceCol.find({}).toArray();
    await targetCol.insertMany(docs);

    const verifyCount = await targetCol.countDocuments();
    console.log(`    ✓ Copied ${verifyCount} documents`);

    if (verifyCount !== count) {
      console.error(`    ✗ Count mismatch! Source: ${count}, Target: ${verifyCount}`);
    }
  }

  await conn.close();
  console.log('\nDone.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
