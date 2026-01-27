/**
 * Migration Script: Environment Variable Keys → MongoDB
 *
 * Migrates provider API keys from environment variables to MongoDB
 */

import dotenv from 'dotenv';
import { connectDB, disconnectDB } from '../src/lib/db';
import { ProviderKey } from '../src/models/provider-key';
import crypto from 'crypto';

dotenv.config();

interface KeyMigration {
  provider: string;
  envVar: string;
  defaultRpm?: number;
  defaultTpm?: number;
  isPaid?: boolean;
}

const KEY_MIGRATIONS: KeyMigration[] = [
  { provider: 'openai', envVar: 'OPENAI_KEYS', defaultRpm: 500, defaultTpm: 150000, isPaid: true },
  { provider: 'anthropic', envVar: 'ANTHROPIC_KEYS', defaultRpm: 50, defaultTpm: 100000, isPaid: true },
  { provider: 'google', envVar: 'GOOGLE_KEYS', defaultRpm: 60, defaultTpm: 60000, isPaid: false },
  { provider: 'groq', envVar: 'GROQ_KEYS', defaultRpm: 30, defaultTpm: 20000, isPaid: false },
  { provider: 'mistral', envVar: 'MISTRAL_KEYS', defaultRpm: 100, defaultTpm: 50000, isPaid: true },
  { provider: 'deepseek', envVar: 'DEEPSEEK_KEYS', defaultRpm: 60, defaultTpm: 100000, isPaid: false },
  { provider: 'together', envVar: 'TOGETHER_KEYS', defaultRpm: 60, defaultTpm: 50000, isPaid: true },
  { provider: 'cerebras', envVar: 'CEREBRAS_KEYS', defaultRpm: 30, defaultTpm: 120000, isPaid: true },
  { provider: 'cloudflare', envVar: 'CLOUDFLARE_KEYS', defaultRpm: 100, defaultTpm: 100000, isPaid: false },
  { provider: 'openrouter', envVar: 'OPENROUTER_KEYS', defaultRpm: 200, defaultTpm: 100000, isPaid: true },
];

async function migrateKeys() {
  console.log('🔄 Starting key migration...\n');

  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const migration of KEY_MIGRATIONS) {
    const { provider, envVar, defaultRpm, defaultTpm, isPaid } = migration;

    console.log(`📦 Processing ${provider}...`);

    const keysString = process.env[envVar];
    if (!keysString || keysString.trim() === '') {
      console.log(`  ⏭️  No keys found in ${envVar}, skipping\n`);
      continue;
    }

    const keys = keysString.split(',').map(k => k.trim()).filter(k => k);
    console.log(`  Found ${keys.length} key(s) in environment`);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const keyHash = crypto.createHash('sha256').update(key).digest('hex');
      const keyPrefix = key.substring(0, Math.min(8, key.length)) + '...';

      try {
        // Check if key already exists
        const existing = await ProviderKey.findOne({ keyHash });
        if (existing) {
          console.log(`  ⏭️  Key ${i + 1} already exists (${keyPrefix})`);
          totalSkipped++;
          continue;
        }

        // Create new key entry
        const priority = i + 1; // First key = priority 1
        await ProviderKey.create({
          name: `${provider.charAt(0).toUpperCase() + provider.slice(1)} Key ${i + 1}`,
          provider,
          keyHash,
          keyPrefix,
          environment: 'production',
          isPaid: isPaid || false,
          tier: isPaid ? 'paid' : 'free',
          currentPriority: priority,     // Dynamic priority (changes on failure)
          originalPriority: priority,    // Original priority (restored on success)
          rateLimit: {
            rpm: defaultRpm,
            tpm: defaultTpm,
          },
          isActive: true,
        });

        console.log(`  ✅ Migrated key ${i + 1} (${keyPrefix})`);
        totalMigrated++;
      } catch (error: any) {
        console.error(`  ❌ Error migrating key ${i + 1}:`, error.message);
        totalErrors++;
      }
    }

    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Migration Summary:');
  console.log(`  ✅ Migrated: ${totalMigrated}`);
  console.log(`  ⏭️  Skipped: ${totalSkipped}`);
  console.log(`  ❌ Errors: ${totalErrors}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (totalMigrated > 0) {
    console.log('✨ Key migration completed successfully!');
    console.log('💡 You can now remove the keys from .env file');
    console.log('💡 Use the Keys API to manage keys going forward');
  } else {
    console.log('ℹ️  No new keys were migrated');
  }
}

// Run migration
(async () => {
  try {
    await connectDB();
    await migrateKeys();
    await disconnectDB();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    await disconnectDB();
    process.exit(1);
  }
})();
