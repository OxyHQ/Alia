/**
 * Migration Script: TypeScript Model Configs → MongoDB
 *
 * Migrates model configurations from TypeScript files to MongoDB
 */

import dotenv from 'dotenv';
import { connectDB, disconnectDB } from '../src/lib/db';
import { ModelConfig } from '../src/models/model-config';
import {
  MODEL_CAPABILITIES,
  MODEL_PRICING,
  ModelCapabilities,
  ModelPricing,
} from '../src/lib/model-capabilities-data';
import { GENERATED_TIER_MAPPINGS } from '../src/lib/generate-model-mappings';

dotenv.config();

async function migrateModels() {
  console.log('🔄 Starting model configuration migration...\n');

  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Get all unique models from tier mappings
  const allModels = new Set<string>();
  const modelToTier = new Map<string, { tier: string; priority: number; qualityScore: number }>();

  for (const [tier, mappings] of Object.entries(GENERATED_TIER_MAPPINGS)) {
    for (const mapping of mappings) {
      const modelKey = `${mapping.provider}:${mapping.modelId}`;
      allModels.add(modelKey);

      // Store tier mapping info (use first occurrence)
      if (!modelToTier.has(modelKey)) {
        modelToTier.set(modelKey, {
          tier,
          priority: mapping.priority,
          qualityScore: mapping.qualityScore,
        });
      }
    }
  }

  console.log(`📦 Found ${allModels.size} unique models to migrate\n`);

  for (const modelKey of allModels) {
    const [provider, modelId] = modelKey.split(':');

    try {
      // Check if model already exists
      const existing = await ModelConfig.findOne({ provider, modelId });
      if (existing) {
        console.log(`⏭️  ${provider}/${modelId} already exists`);
        totalSkipped++;
        continue;
      }

      // Get capabilities and pricing
      const capabilities = MODEL_CAPABILITIES[modelId] || getDefaultCapabilities();
      const pricing = MODEL_PRICING[modelId] || getDefaultPricing();
      const tierInfo = modelToTier.get(modelKey);

      // Create display name
      const displayName = modelId
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      // Create model config
      await ModelConfig.create({
        modelId,
        provider,
        displayName,
        aliaTier: tierInfo?.tier,
        priority: tierInfo?.priority,
        qualityScore: tierInfo?.qualityScore,
        capabilities: {
          vision: capabilities.vision || false,
          audio: capabilities.audio || false,
          codeExecution: capabilities.codeExecution || false,
          webSearch: capabilities.webSearch || false,
          computerUse: capabilities.computerUse || false,
          thinking: capabilities.thinking || false,
          streaming: capabilities.streaming !== false, // default true
          functionCalling: capabilities.functionCalling !== false, // default true
          jsonMode: capabilities.jsonMode || false,
          promptCaching: capabilities.promptCaching || false,
        },
        limits: {
          maxContextTokens: capabilities.maxContextTokens || 128000,
          maxOutputTokens: capabilities.maxOutputTokens || 4096,
        },
        pricing: {
          tier: pricing.tier || 'freemium',
          costPer1MInput: pricing.costPer1MInput || 0,
          costPer1MOutput: pricing.costPer1MOutput || 0,
          costPer1MCachedInput: pricing.costPer1MCachedInput,
          averageLatencyMs: pricing.averageLatencyMs || 1500,
        },
        isActive: true,
        isDeprecated: false,
      });

      console.log(`✅ Migrated ${provider}/${modelId}`);
      totalMigrated++;
    } catch (error: any) {
      console.error(`❌ Error migrating ${provider}/${modelId}:`, error.message);
      totalErrors++;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Migration Summary:');
  console.log(`  ✅ Migrated: ${totalMigrated}`);
  console.log(`  ⏭️  Skipped: ${totalSkipped}`);
  console.log(`  ❌ Errors: ${totalErrors}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (totalMigrated > 0) {
    console.log('✨ Model configuration migration completed successfully!');
    console.log('💡 Models are now managed in MongoDB');
    console.log('💡 TypeScript files will remain as fallback');
  } else {
    console.log('ℹ️  No new models were migrated');
  }
}

function getDefaultCapabilities(): ModelCapabilities {
  return {
    vision: false,
    audio: false,
    codeExecution: false,
    webSearch: false,
    computerUse: false,
    thinking: false,
    streaming: true,
    functionCalling: true,
    jsonMode: false,
    promptCaching: false,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
  };
}

function getDefaultPricing(): ModelPricing {
  return {
    tier: 'freemium',
    costPer1MInput: 0,
    costPer1MOutput: 0,
    averageLatencyMs: 1500,
  };
}

// Run migration
(async () => {
  try {
    await connectDB();
    await migrateModels();
    await disconnectDB();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    await disconnectDB();
    process.exit(1);
  }
})();
