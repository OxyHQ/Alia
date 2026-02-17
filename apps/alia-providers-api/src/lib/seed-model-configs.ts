/**
 * Seed ModelConfig collection from TIER_MODEL_MAPPINGS
 *
 * Populates the ModelConfig MongoDB collection with all provider models
 * from the hardcoded tier mappings. Uses upsert for idempotency.
 * Also resets any open circuit breakers on startup.
 */

import { ModelConfig } from '../models/model-config.js';
import { AliaModel } from '../models/alia-model.js';
import { ProviderKey } from '../models/provider-key.js';
import { TIER_MODEL_MAPPINGS, ALIA_MODELS, type ModelCapabilities } from './alia-models.js';
import { connectDB } from './db.js';
import mongoose from 'mongoose';
import { log } from './logger.js';

// Human-readable display names for common models
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
  'gemini-3-pro-preview': 'Gemini 3 Pro Preview',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o-realtime-preview': 'GPT-4o Realtime Preview',
  'o1': 'OpenAI O1',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-opus-4-20241120': 'Claude Opus 4',
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
  'llama-3.3-70b-versatile': 'Llama 3.3 70B Versatile',
  'whisper-large-v3-turbo': 'Whisper Large V3 Turbo',
  'whisper-large-v3': 'Whisper Large V3',
  'whisper-1': 'Whisper 1',
  '@cf/meta/llama-3.2-11b-vision-instruct': 'Llama 3.2 11B Vision (CF)',
  'grok-realtime': 'Grok Realtime',
};

function getDisplayName(provider: string, modelId: string): string {
  if (MODEL_DISPLAY_NAMES[modelId]) return MODEL_DISPLAY_NAMES[modelId];
  // Auto-generate from modelId
  return modelId
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function seedModelConfigs(): Promise<{ seeded: number; skipped: number }> {
  await connectDB();

  let seeded = 0;
  let skipped = 0;

  // Collect unique provider+modelId combinations across all tiers
  const seen = new Set<string>();

  for (const [tier, mappings] of Object.entries(TIER_MODEL_MAPPINGS) as [string, any[]][]) {
    for (const mapping of mappings) {
      const uniqueKey = `${mapping.provider}:${mapping.modelId}`;

      const validProviders = [
        'openai', 'anthropic', 'google', 'groq', 'mistral',
        'deepseek', 'together', 'cerebras', 'cloudflare', 'openrouter', 'xai',
      ];
      if (!validProviders.includes(mapping.provider)) {
        log.seed.info({ provider: mapping.provider, modelId: mapping.modelId }, 'Skipping - provider not in schema enum');
        skipped++;
        continue;
      }

      const capabilities: Partial<ModelCapabilities> = mapping.capabilities || {};

      try {
        const result = await ModelConfig.updateOne(
          { provider: mapping.provider, modelId: mapping.modelId },
          {
            $setOnInsert: {
              displayName: getDisplayName(mapping.provider, mapping.modelId),
              capabilities: {
                vision: capabilities.vision || false,
                audio: capabilities.audio || false,
                codeExecution: capabilities.codeExecution || false,
                webSearch: capabilities.webSearch || false,
                computerUse: capabilities.computerUse || false,
                thinking: false,
                streaming: capabilities.streaming !== false,
                functionCalling: capabilities.functionCalling !== false,
                jsonMode: false,
                promptCaching: capabilities.promptCaching || false,
              },
              limits: {
                maxContextTokens: capabilities.maxContextTokens || 8192,
                maxOutputTokens: capabilities.maxOutputTokens || 4096,
              },
              pricing: {
                tier: mapping.pricingTier || 'freemium',
                costPer1MInput: mapping.costPer1MInput || 0,
                costPer1MOutput: mapping.costPer1MOutput || 0,
                averageLatencyMs: mapping.averageLatencyMs || 1500,
              },
              isActive: true,
              isDeprecated: false,
            },
            $set: {
              // Always update tier mapping info (allows re-running to update priorities)
              aliaTier: tier,
              priority: mapping.priority,
              qualityScore: mapping.qualityScore,
            },
          },
          { upsert: true }
        );

        if (result.upsertedCount > 0) {
          seeded++;
          if (!seen.has(uniqueKey)) {
            log.seed.info({ provider: mapping.provider, modelId: mapping.modelId, tier }, 'Created ModelConfig');
          }
        } else {
          if (!seen.has(uniqueKey)) {
            skipped++;
          }
        }

        seen.add(uniqueKey);
      } catch (error: any) {
        // Handle duplicate key errors gracefully (same model in multiple tiers)
        if (error.code === 11000) {
          skipped++;
        } else {
          log.seed.error({ err: error, uniqueKey }, 'Error seeding ModelConfig');
        }
      }
    }
  }

  log.seed.info({ seeded, skipped }, 'ModelConfig seeding complete');
  return { seeded, skipped };
}

/**
 * Seed AliaModel collection from ALIA_MODELS and TIER_MODEL_MAPPINGS
 *
 * Creates virtual Alia models (alia-v1, alia-lite, etc.) in MongoDB
 * with their provider mappings linked to ModelConfig documents.
 * Must run AFTER seedModelConfigs() so ModelConfig references exist.
 */
export async function seedAliaModels(): Promise<{ seeded: number; skipped: number }> {
  await connectDB();

  let seeded = 0;
  let skipped = 0;

  const validProviders = [
    'openai', 'anthropic', 'google', 'groq', 'mistral',
    'deepseek', 'together', 'cerebras', 'cloudflare', 'openrouter', 'xai',
  ];

  for (const [modelId, aliaModel] of Object.entries(ALIA_MODELS)) {
    try {
      // Get tier mappings for this model's tier
      const tierMappings = TIER_MODEL_MAPPINGS[aliaModel.tier] || [];

      // Build provider mappings with ModelConfig references
      const providerMappings = [];
      for (const mapping of tierMappings) {
        if (!validProviders.includes(mapping.provider)) continue;

        const modelConfig = await ModelConfig.findOne({
          provider: mapping.provider,
          modelId: mapping.modelId,
        });

        if (modelConfig) {
          providerMappings.push({
            modelConfigId: modelConfig._id,
            provider: mapping.provider,
            modelId: mapping.modelId,
            priority: mapping.priority,
            qualityScore: mapping.qualityScore,
            isActive: true,
          });
        }
      }

      // Determine aggregated capabilities from tier mappings
      const hasVision = tierMappings.some((m: any) => m.capabilities?.vision);
      const hasAudio = tierMappings.some((m: any) => m.capabilities?.audio);
      const hasCodeExecution = tierMappings.some((m: any) => m.capabilities?.codeExecution);
      const hasWebSearch = tierMappings.some((m: any) => m.capabilities?.webSearch);

      const result = await AliaModel.updateOne(
        { aliasModelId: modelId },
        {
          $setOnInsert: {
            displayName: aliaModel.name,
            tier: aliaModel.tier,
            description: aliaModel.description,
            creditMultiplier: aliaModel.creditMultiplier,
            isFreeTier: aliaModel.creditMultiplier <= 1.0,
            isActive: true,
            isDeprecated: false,
          },
          $set: {
            providerMappings,
            aggregatedCapabilities: {
              vision: hasVision,
              audio: hasAudio,
              codeExecution: hasCodeExecution,
              webSearch: hasWebSearch,
              thinking: false,
            },
          },
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        seeded++;
        log.seed.info({ modelId, tier: aliaModel.tier, providers: providerMappings.length }, 'Created AliaModel');
      } else {
        skipped++;
      }
    } catch (error: any) {
      if (error.code === 11000) {
        skipped++;
      } else {
        log.seed.error({ err: error, modelId }, 'Error seeding AliaModel');
      }
    }
  }

  log.seed.info({ seeded, skipped }, 'AliaModel seeding complete');
  return { seeded, skipped };
}

/**
 * Reset all open circuit breakers to closed state
 */
export async function resetAllCircuitBreakers(): Promise<number> {
  await connectDB();

  const ProviderHealth = mongoose.models.ProviderHealth;
  if (!ProviderHealth) {
    log.seed.info('ProviderHealth model not loaded yet, skipping circuit breaker reset');
    return 0;
  }

  const result = await ProviderHealth.updateMany(
    { circuitState: { $in: ['open', 'half-open'] } },
    {
      $set: {
        circuitState: 'closed',
        circuitOpenedAt: null,
        halfOpenAttempts: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        isHealthy: true,
        lastHealthCheck: new Date(),
      },
    }
  );

  if (result.modifiedCount > 0) {
    log.seed.info({ count: result.modifiedCount }, 'Reset open circuit breakers to closed');
  }

  return result.modifiedCount;
}

/**
 * Reset all key cooldowns and consecutive failure counters.
 * Prevents stale lockouts from persisting across deploys.
 */
export async function resetAllKeyCooldowns(): Promise<number> {
  await connectDB();

  const result = await ProviderKey.updateMany(
    { $or: [{ cooldownUntil: { $ne: null } }, { consecutiveFailures: { $gt: 0 } }] },
    { $set: { cooldownUntil: null, consecutiveFailures: 0 } }
  );

  if (result.modifiedCount > 0) {
    log.seed.info({ count: result.modifiedCount }, 'Reset key cooldowns and failure counters');
  }

  return result.modifiedCount;
}

/**
 * Run all seed operations on startup
 */
export async function runStartupSeed(): Promise<void> {
  try {
    log.seed.info('Running startup seed operations...');
    await seedModelConfigs();
    await seedAliaModels();
    const { seedPlans } = await import('./seed-plans.js');
    await seedPlans();
    const { seedCreditPackages } = await import('./seed-credit-packages.js');
    await seedCreditPackages();
    const { seedFeatures, seedPlanFeatures } = await import('./seed-features.js');
    await seedFeatures();
    await seedPlanFeatures();
    await resetAllCircuitBreakers();
    await resetAllKeyCooldowns();
    log.seed.info('Startup seed complete');
  } catch (error) {
    log.seed.error({ err: error }, 'Error during startup seed');
  }
}
