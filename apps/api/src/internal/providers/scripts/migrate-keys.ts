/**
 * Migration Script: ApiKey → ProviderKey
 *
 * Migrates keys from the old ApiKey collection (plaintext keys)
 * to the new ProviderKey collection (encrypted keys with priority rotation).
 *
 * - Creates new ProviderKey documents for keys that don't exist yet
 * - Updates existing ProviderKey documents that are missing encryptedKey
 *
 * Usage:
 *   npx tsx apps/api/src/internal/providers/scripts/migrate-keys.ts
 *
 * Required env vars:
 *   MONGODB_URI          - MongoDB connection string
 *   KEY_ENCRYPTION_SECRET - Secret for AES-256-GCM encryption
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { ApiKey } from '../../../models/api-key.js';
import { ProviderKey } from '../models/provider-key.js';
import { encryptKey } from '../lib/key-encryption.js';

async function migrate() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/alia';

  if (!process.env.KEY_ENCRYPTION_SECRET) {
    console.error('KEY_ENCRYPTION_SECRET env var is required');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('Connected');

  const apiKeys = await ApiKey.find({});
  console.log(`Found ${apiKeys.length} keys in ApiKey collection`);

  if (apiKeys.length === 0) {
    console.log('Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const oldKey of apiKeys) {
    try {
      const keyHash = crypto.createHash('sha256').update(oldKey.key).digest('hex');
      const encrypted = encryptKey(oldKey.key);
      const existing = await ProviderKey.findOne({ keyHash });

      if (existing) {
        if (existing.encryptedKey) {
          console.log(`  Skip ${oldKey.provider} (${oldKey.key.substring(0, 8)}...) - already has encryptedKey`);
          skipped++;
          continue;
        }

        // Update existing doc with missing encryptedKey
        existing.encryptedKey = encrypted;
        await existing.save();
        console.log(`  Updated ${oldKey.provider} (${oldKey.key.substring(0, 8)}...) - added encryptedKey`);
        updated++;
        continue;
      }

      // Create new ProviderKey
      const priority = oldKey.isPaid ? 5 : 10;

      const providerKey = new ProviderKey({
        name: `${oldKey.provider}-${oldKey.modelId || 'default'}-migrated`,
        provider: oldKey.provider,
        environment: 'production',
        keyHash,
        keyPrefix: oldKey.key.substring(0, Math.min(8, oldKey.key.length)) + '...',
        encryptedKey: encrypted,
        rateLimit: {
          rpm: oldKey.rpm,
          rpd: oldKey.rpd,
          tpm: oldKey.tpm,
          tpd: oldKey.tpd,
        },
        isActive: oldKey.isActive,
        isPaid: oldKey.isPaid,
        tier: oldKey.isPaid ? 'paid' : 'free',
        currentPriority: priority,
        originalPriority: priority,
        totalRequests: 0,
        totalTokens: 0,
        successCount: 0,
        consecutiveFailures: 0,
        totalFailures: 0,
        maxTotalFailures: 100,
        isArchived: false,
      });

      await providerKey.save();
      console.log(`  Created ${oldKey.provider} (${oldKey.key.substring(0, 8)}...)`);
      created++;
    } catch (err: any) {
      console.error(`  Error ${oldKey.provider}/${oldKey.modelId}: ${err.message}`);
      errors++;
    }
  }

  console.log('\nMigration summary:');
  console.log(`  Created: ${created}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors:  ${errors}`);

  await mongoose.disconnect();
  console.log('Done');
}

migrate().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
