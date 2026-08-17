/**
 * Seed the routing catalogue from TIER_MODEL_MAPPINGS.
 *
 * Populates the `model_configs` and `alia_models` PostgreSQL tables from the
 * hardcoded tier mappings, through the repositories in `db/providers/`. Uses
 * upsert for idempotency. Also resets any open circuit breakers on startup.
 *
 * Under ADR 0001 these tables stop being written by Alia and become migration
 * inputs rather than live state; they are dropped under the gates in workstream
 * 10 of #139.
 */

import { findModelConfig, upsertModelConfig } from '../../../db/providers/modelConfigRepository.js';
import { upsertAliaModel } from '../../../db/providers/aliaModelRepository.js';
import { resetAllKeyCooldowns as resetKeyCooldowns } from '../../../db/providers/providerKeyRepository.js';
import type { ConfigAuditActor } from '../../../lib/security/config-audit.js';

/**
 * Who the seed is, for the audit record every configuration writer emits.
 *
 * `seed` rather than `service`: nobody chose these values in this run, the
 * module did, and an audit log that attributed a deploy-time re-seed to a
 * person would be worse than one that says so plainly.
 */
const SEED_ACTOR: ConfigAuditActor = {
  kind: 'seed',
  id: 'internal/providers/lib/seed-model-configs',
};
import { getDb } from '../../../db/index.js';
import { TIER_MODEL_MAPPINGS, ALIA_MODELS, type ModelCapabilities } from './alia-models.js';
import { connectDB } from './db.js';
import { resetAllCircuitBreakers } from './provider-health.js';
import { log } from '../../../lib/logger.js';
import { isDuplicateKeyError } from '../../../lib/errors/index.js';

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
  // Truthiness followed by a read is the shape: for an inherited name the test
  // passes and the read returns a function from a `string` signature. Not
  // reachable — `modelId` comes from the seed table — but it is one line.
  if (Object.hasOwn(MODEL_DISPLAY_NAMES, modelId)) return MODEL_DISPLAY_NAMES[modelId];
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

  for (const [tier, mappings] of Object.entries(TIER_MODEL_MAPPINGS)) {
    for (const mapping of mappings) {
      const uniqueKey = `${mapping.provider}:${mapping.modelId}`;

      const validProviders = [
        'openai', 'anthropic', 'google', 'groq', 'mistral',
        'deepseek', 'together', 'cerebras', 'cloudflare', 'openrouter', 'xai',
        'fireworks', 'hyperbolic', 'sambanova', 'novita', 'replicate', 'cohere', 'perplexity',
      ];
      if (!validProviders.includes(mapping.provider)) {
        log.seed.info({ provider: mapping.provider, modelId: mapping.modelId }, 'Skipping - provider not in schema enum');
        skipped++;
        continue;
      }

      const capabilities: Partial<ModelCapabilities> = mapping.capabilities || {};

      try {
        const result = await upsertModelConfig(
          getDb(),
          { provider: mapping.provider, modelId: mapping.modelId },
          {
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
          {
            // Always update tier mapping info (allows re-running to update priorities)
            aliaTier: tier,
            priority: mapping.priority,
            qualityScore: mapping.qualityScore,
          },
          SEED_ACTOR,
        );

        // `inserted` comes from `xmax = 0`, which is Postgres's answer to the
        // question `upsertedCount` answered: was this tuple created by the
        // statement, or updated by it.
        if (result.inserted) {
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
      } catch (error: unknown) {
        // Handle duplicate key errors gracefully (same model in multiple tiers)
        if (isDuplicateKeyError(error)) {
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
 * Seed `alia_models` from ALIA_MODELS and TIER_MODEL_MAPPINGS.
 *
 * Writes the alia-* identifiers (alia-v1, alia-lite and the rest) with their
 * mappings linked to `model_configs` rows. Must run AFTER seedModelConfigs() so
 * those rows exist.
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

        const modelConfig = await findModelConfig(getDb(), mapping.provider, mapping.modelId);

        if (modelConfig) {
          providerMappings.push({
            modelConfigId: modelConfig.id,
            provider: mapping.provider,
            modelId: mapping.modelId,
            priority: mapping.priority,
            qualityScore: mapping.qualityScore,
            isActive: true,
          });
        }
      }

      // Determine aggregated capabilities from tier mappings
      const hasVision = tierMappings.some(m => m.capabilities?.vision);
      const hasAudio = tierMappings.some(m => m.capabilities?.audio);
      const hasCodeExecution = tierMappings.some(m => m.capabilities?.codeExecution);
      const hasWebSearch = tierMappings.some(m => m.capabilities?.webSearch);

      const result = await upsertAliaModel(
        getDb(),
        modelId,
        {
          displayName: aliaModel.name,
          tier: aliaModel.tier,
          description: aliaModel.description,
          creditMultiplier: aliaModel.creditMultiplier,
          isFreeTier: aliaModel.creditMultiplier <= 1.0,
          isActive: true,
          isDeprecated: false,
        },
        {
          aggregatedCapabilities: {
            vision: hasVision,
            audio: hasAudio,
            codeExecution: hasCodeExecution,
            webSearch: hasWebSearch,
            thinking: false,
          },
        },
        providerMappings,
        SEED_ACTOR,
      );

      if (result.inserted) {
        seeded++;
        log.seed.info({ modelId, tier: aliaModel.tier, providers: providerMappings.length }, 'Created AliaModel');
      } else {
        skipped++;
      }
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
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
 * Reset all key cooldowns and consecutive failure counters.
 * Prevents stale lockouts from persisting across deploys.
 */
export async function resetAllKeyCooldowns(): Promise<number> {
  /**
   * `rowCount` standing in for `modifiedCount`, and sound here for a reason
   * worth checking rather than assuming: the filter selects only rows that HAVE
   * a cooldown or a non-zero failure run, and the update clears both — so every
   * matched row necessarily changes and the two counts cannot diverge.
   */
  const reset = await resetKeyCooldowns(getDb(), SEED_ACTOR);

  if (reset > 0) {
    log.seed.info({ count: reset }, 'Reset key cooldowns and failure counters');
  }

  return reset;
}

/**
 * Run all seed operations on startup
 */
export async function runStartupSeed(): Promise<void> {
  try {
    log.seed.info('Running startup seed operations...');
    await seedModelConfigs();
    await seedAliaModels();
    const { seedCreditPackages } = await import('./seed-credit-packages.js');
    await seedCreditPackages();
    const { seedFeatures, seedPlanFeatures } = await import('./seed-features.js');
    await seedFeatures();
    await seedPlanFeatures();
    // Owned by `provider-health.ts`, the one module that touches
    // `provider_health`. It used to be defined here and reach the collection
    // through `mongoose.models.ProviderHealth`, bypassing that chokepoint.
    const closed = await resetAllCircuitBreakers();
    if (closed > 0) {
      log.seed.info({ count: closed }, 'Reset open circuit breakers to closed');
    }
    await resetAllKeyCooldowns();
    log.seed.info('Startup seed complete');
  } catch (error) {
    log.seed.error({ err: error }, 'Error during startup seed');
  }
}
