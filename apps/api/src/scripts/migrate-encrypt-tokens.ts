/**
 * One-time migration: encrypt existing plaintext OAuth tokens.
 *
 * Usage:
 *   TOKEN_ENCRYPTION_KEY=<64-hex-chars> npx tsx src/scripts/migrate-encrypt-tokens.ts
 *
 * - Reads all Integration and ConnectedAccount documents with oauthTokens
 * - Skips tokens that are already encrypted (detected by isEncrypted())
 * - Encrypts plaintext tokens in-place using AES-256-GCM
 * - Prints a summary of how many documents were migrated
 *
 * Safe to run multiple times — already-encrypted tokens are skipped.
 */

import mongoose from 'mongoose';
import { connectDB } from '../lib/db.js';
import { encrypt, isEncrypted } from '../lib/crypto-utils.js';

async function migrateCollection(
  collectionName: string,
  Model: mongoose.Model<any>,
  tokenFields: { access: string; refresh: string },
) {
  let migrated = 0;
  let skipped = 0;
  let total = 0;

  const cursor = Model.find({ [tokenFields.access]: { $exists: true, $ne: null } }).cursor();

  for await (const doc of cursor) {
    total++;
    const tokens = doc.oauthTokens;
    if (!tokens) {
      skipped++;
      continue;
    }

    let changed = false;

    // Use doc.get with getters: false to read raw DB value
    const rawAccess = doc.get('oauthTokens.accessToken', null, { getters: false });
    const rawRefresh = doc.get('oauthTokens.refreshToken', null, { getters: false });

    if (rawAccess && !isEncrypted(rawAccess)) {
      // Write encrypted value directly to bypass the setter (which would double-encrypt)
      await Model.updateOne(
        { _id: doc._id },
        { $set: { 'oauthTokens.accessToken': encrypt(rawAccess) } },
      );
      changed = true;
    }

    if (rawRefresh && !isEncrypted(rawRefresh)) {
      await Model.updateOne(
        { _id: doc._id },
        { $set: { 'oauthTokens.refreshToken': encrypt(rawRefresh) } },
      );
      changed = true;
    }

    if (changed) {
      migrated++;
    } else {
      skipped++;
    }
  }

  console.log(`  ${collectionName}: ${migrated} migrated, ${skipped} skipped (already encrypted or no tokens), ${total} total`);
  return migrated;
}

async function main() {
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    console.error('ERROR: TOKEN_ENCRYPTION_KEY env var must be set.');
    console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }

  console.log('Connecting to database...');
  await connectDB();

  // Import models after DB connection
  const { Integration } = await import('../models/integration.js');
  const { ConnectedAccount } = await import('../models/connected-account.js');

  console.log('\nMigrating OAuth tokens to encrypted storage...\n');

  const intMigrated = await migrateCollection(
    'Integration',
    Integration,
    { access: 'oauthTokens.accessToken', refresh: 'oauthTokens.refreshToken' },
  );

  const caMigrated = await migrateCollection(
    'ConnectedAccount',
    ConnectedAccount,
    { access: 'oauthTokens.accessToken', refresh: 'oauthTokens.refreshToken' },
  );

  const totalMigrated = intMigrated + caMigrated;
  console.log(`\nDone. ${totalMigrated} documents migrated.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
