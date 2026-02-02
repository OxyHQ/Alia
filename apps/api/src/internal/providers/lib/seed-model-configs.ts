/**
 * Seed ModelConfig collection from TIER_MODEL_MAPPINGS
 *
 * Populates the ModelConfig MongoDB collection with all provider models
 * from the hardcoded tier mappings. Uses upsert for idempotency.
 * Also resets any open circuit breakers on startup.
 */

import { ModelConfig } from '../models/model-config.js';
import { TIER_MODEL_MAPPINGS, type ModelCapabilities } from './alia-models.js';
import { connectDB } from './db.js';
import mongoose from 'mongoose';

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

  for (const [tier, mappings] of Object.entries(TIER_MODEL_MAPPINGS)) {
    for (const mapping of mappings) {
      const uniqueKey = `${mapping.provider}:${mapping.modelId}`;

      // Skip voice providers not in the schema enum (e.g., 'grok')
      const validProviders = [
        'openai', 'anthropic', 'google', 'groq', 'mistral',
        'deepseek', 'together', 'cerebras', 'cloudflare', 'openrouter',
      ];
      if (!validProviders.includes(mapping.provider)) {
        console.log(`[Seed] Skipping ${uniqueKey} - provider not in schema enum`);
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
            console.log(`[Seed] Created ModelConfig: ${mapping.provider}/${mapping.modelId} (tier: ${tier})`);
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
          console.error(`[Seed] Error seeding ${uniqueKey}:`, error.message);
        }
      }
    }
  }

  console.log(`[Seed] ModelConfig seeding complete: ${seeded} created, ${skipped} skipped/existing`);
  return { seeded, skipped };
}

/**
 * Reset all open circuit breakers to closed state
 */
export async function resetAllCircuitBreakers(): Promise<number> {
  await connectDB();

  const ProviderHealth = mongoose.models.ProviderHealth;
  if (!ProviderHealth) {
    console.log('[Seed] ProviderHealth model not loaded yet, skipping circuit breaker reset');
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
    console.log(`[Seed] Reset ${result.modifiedCount} open circuit breakers to closed`);
  }

  return result.modifiedCount;
}

/**
 * Run all seed operations on startup
 */
export async function runStartupSeed(): Promise<void> {
  try {
    console.log('[Seed] Running startup seed operations...');
    await seedModelConfigs();
    await resetAllCircuitBreakers();
    console.log('[Seed] Startup seed complete');
  } catch (error) {
    console.error('[Seed] Error during startup seed:', error);
  }
}
