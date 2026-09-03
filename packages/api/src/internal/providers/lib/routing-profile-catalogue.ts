/**
 * Kaana routing-profile catalogue
 *
 * This module defines the Kaana routing profile tiers and their mappings to real provider models.
 * Users see only Kaana routing profiles (kaana-lite, kaana-v1, etc.) while internally
 * requests are routed to appropriate provider models.
 */

/**
 * The tier vocabulary comes from `routing-tiers.ts`, the tuple the database's
 * `routing_profiles_tier_check` is rendered from. It was restated here as a literal
 * union and the two copies had drifted: this one had `v1-image` and the tuple
 * did not, so every image mapping the seeder wrote was refused by
 * `model_configs_alia_tier_check`, on every boot. That column has since been
 * dropped for a different reason — it recorded one tier per
 * `(provider, model_id)` pair over a many-to-many mapping — but the drift is
 * why this file imports the type rather than restating it.
 */
import type { RoutingTier } from './routing-tiers.js';
import type { ModelPublisher } from './model-publishers';

export type ModelCategory = 'general' | 'coding' | 'vision' | 'audio' | 'multimodal' | 'voice';
export type PricingTier = 'free' | 'freemium' | 'paid';

export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  video: boolean;
  voice: boolean;                // Real-time voice conversations
  /**
   * A TTS model that PERFORMS a bracketed audio tag — `[laughs]`, `[whispers]` —
   * rather than reading the characters out.
   *
   * False for every other model, and that is the load-bearing default: a model
   * whose answer is unknown reads the tag aloud, which is the failure this flag
   * exists to stop. `synthesize-speech.ts` consults it per mapping, because the
   * TTS tier fails over and the answer differs between the model that was tried
   * first and the one that actually served.
   */
  audioTags: boolean;
  tools: boolean;
  codeExecution: boolean;       // Built-in code execution (Groq Compound)
  webSearch: boolean;            // Built-in web search (GPT-OSS)
  computerUse: boolean;          // Claude computer use
  streaming: boolean;
  systemPrompts: boolean;
  functionCalling: boolean;
  promptCaching: boolean;        // Claude/OpenAI prompt caching support
  maxContextTokens: number;      // 8k, 128k, 1M, etc.
  maxOutputTokens: number;
}

export interface RoutingProfile {
  id: string;
  name: string;
  tier: RoutingTier;
  description: string;
  creditMultiplier: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  category: ModelCategory;
  emoji?: string;
}

export interface ModelMapping {
  /** Whose endpoint the request goes to. One of `PROVIDER_NAMES`. */
  provider: string;
  /**
   * Who RELEASED the model, which is not who serves it.
   *
   * `{ provider: 'digitalocean', publisher: 'openai', modelId: 'openai-gpt-oss-20b' }`
   * is the whole distinction in one row. Required rather than optional, and
   * placed beside `provider` rather than anywhere else, so every mapping states
   * both and no reader can mistake one for the other.
   *
   * Never derived from `modelId`: 97 of the 115 mappings carry a bare model
   * name with no publisher token, and where a prefix does exist it is sometimes
   * the inference platform (`fal-ai/fast-sdxl` is Stability's). See
   * `model-publishers.ts`.
   */
  publisher: ModelPublisher;
  /**
   * The publisher's own name for the model, which is NOT what the operator
   * calls its deployment.
   *
   * Meta's Llama 3.3 70B reaches users as `Meta-Llama-3.3-70B-Instruct`,
   * `llama-3.3-70b`, `llama-3.3-70b-versatile`, `llama3.3-70b-instruct`,
   * `meta-llama/llama-3.3-70b-instruct` and `meta/meta-llama-3.3-70b-instruct`.
   * Six ids, one model — and `same-model-only` fallback compared `modelId`, so
   * it treated them as six models and refused five legitimate deployments of
   * the one the caller asked for.
   *
   * With `publisher`, this completes ADR 0003's `publisher/model` identity.
   * Authored, never parsed: 29 of the 58 deployment ids differ from their
   * model's name, and where sameness is uncertain the names stay DISTINCT —
   * under-collapsing matches today's behaviour, over-collapsing asserts two
   * different models are one, which is the error the policy exists to prevent.
   */
  model: string;
  /** What the OPERATOR calls this deployment. Provider-specific, never an identity. */
  modelId: string;
  priority: number;
  qualityScore: number;
  pricingTier: PricingTier;
  costPer1MInput?: number;       // USD per 1M input tokens
  costPer1MOutput?: number;      // USD per 1M output tokens
  costPerMinute?: number;        // USD per minute (for voice/realtime models)
  averageLatencyMs?: number;     // Tracked performance
  capabilities: ModelCapabilities;
}

/**
 * Kaana routing profile definitions
 */
export const KAANA_ROUTING_PROFILES: Record<string, RoutingProfile> = {
  'kaana-lite': {
    id: 'kaana-lite',
    name: 'Kaana Lite',
    tier: 'lite',
    description: 'Fast responses for simple tasks',
    creditMultiplier: 0.5,
    maxTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    category: 'general',
    emoji: '⚡',
  },
  'kaana-v1': {
    id: 'kaana-v1',
    name: 'Kaana V1',
    tier: 'v1',
    description: 'Balanced performance for everyday tasks',
    creditMultiplier: 1,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '🎯',
  },
  'kaana-v1-codea': {
    id: 'kaana-v1-codea',
    name: 'Codea',
    tier: 'v1-codea',
    description: 'Fast coding assistant',
    creditMultiplier: 1.5,
    maxTokens: 16384,
    supportsTools: true,
    supportsVision: false,
    category: 'coding',
    emoji: '💻',
  },
  'kaana-v1-cowork': {
    id: 'kaana-v1-cowork',
    name: 'Kaana V1 Cowork',
    tier: 'v1-cowork',
    description: 'Desktop automation assistant with tool support',
    creditMultiplier: 1.5,
    maxTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    category: 'coding',
    emoji: '🖥️',
  },
  'kaana-v1-browser': {
    id: 'kaana-v1-browser',
    name: 'Kaana V1 Browser',
    tier: 'v1-browser',
    description: 'Browser automation specialist for web interactions',
    creditMultiplier: 1.5,
    maxTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    category: 'coding',
    emoji: '🌐',
  },
  'kaana-v1-vision': {
    id: 'kaana-v1-vision',
    name: 'Kaana V1 Vision',
    tier: 'v1-vision',
    description: 'Specialized for image analysis, vision, and visual reasoning',
    creditMultiplier: 1.5,
    maxTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    category: 'vision',
    emoji: '👁️',
  },
  'kaana-v1-audio': {
    id: 'kaana-v1-audio',
    name: 'Kaana V1 Audio',
    tier: 'v1-audio',
    description: 'Specialized for audio transcription, speech-to-text, and audio analysis',
    creditMultiplier: 1.0,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    category: 'audio',
    emoji: '🎤',
  },
  'kaana-v1-multimodal': {
    id: 'kaana-v1-multimodal',
    name: 'Kaana V1 Multimodal',
    tier: 'v1-multimodal',
    description: 'Handles text, images, audio, and video in a single conversation',
    creditMultiplier: 2.0,
    maxTokens: 32768,
    supportsTools: true,
    supportsVision: true,
    category: 'multimodal',
    emoji: '🎨',
  },
  'kaana-v1-pro': {
    id: 'kaana-v1-pro',
    name: 'Codea Pro',
    tier: 'v1-pro',
    description: 'Advanced reasoning for complex tasks',
    creditMultiplier: 3,
    maxTokens: 32768,
    supportsTools: true,
    supportsVision: true,
    category: 'coding',
    emoji: '⭐',
  },
  'kaana-v1-thinking': {
    id: 'kaana-v1-thinking',
    name: 'Kaana V1 Thinking',
    tier: 'v1-pro-max',
    description: 'Extended thinking for complex problems',
    creditMultiplier: 5,
    maxTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    category: 'coding',
    emoji: '🧠',
  },
  'kaana-v1-pro-max': {
    id: 'kaana-v1-pro-max',
    name: 'Kaana V1 Pro Max',
    tier: 'v1-pro-max',
    description: 'Best available models for demanding tasks',
    creditMultiplier: 5,
    maxTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '🚀',
  },
  'kaana-v1-voice': {
    id: 'kaana-v1-voice',
    name: 'Kaana V1 Voice',
    tier: 'v1-voice',
    description: 'Real-time voice conversations with low latency',
    creditMultiplier: 2.0,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    category: 'voice',
    emoji: '🗣️',
  },
  'kaana-v1-voice-pro': {
    id: 'kaana-v1-voice-pro',
    name: 'Kaana V1 Voice Pro',
    tier: 'v1-voice-pro',
    description: 'Premium voice with extended context and advanced features',
    creditMultiplier: 4.0,
    maxTokens: 32768,
    supportsTools: true,
    supportsVision: false,
    category: 'voice',
    emoji: '🎙️',
  },
};

/**
 * Model mappings by tier (ordered by priority - lower priority number = try first)
 *
 * IMPORTANT: Only REAL, currently available models are mapped
 *
 * Special Capabilities by Model:
 * - gemini-3-flash-preview: Vision, code execution, web search (urlContext), 1M context
 * - gemini-3-pro-preview: Vision, code execution, web search, 1M context, extended output
 * - gemini-2.5-pro: Vision, multimodal, 2M token context, prompt caching
 * - deepseek-reasoner: Advanced reasoning and thinking mode
 * - claude-sonnet-4/opus-4: Computer use capability, vision, prompt caching
 * - gpt-4o: Vision, 128k context, fast multimodal responses
 * - o1: Advanced reasoning, 200k context, extended thinking
 * - llama-3.2-11b-vision-instruct: Vision & image reasoning (Cloudflare)
 * - openai/gpt-oss-120b: Fast, 128k context (Groq; its llama-3.3 line is gone)
 */

// Import the generated mappings with full capabilities and pricing data
import { GENERATED_TIER_MAPPINGS } from './generate-model-mappings';
export const TIER_MODEL_MAPPINGS = GENERATED_TIER_MAPPINGS;

/**
 * Get Kaana routing profile by ID.
 *
 * `Object.hasOwn` rather than a truthy read, because `modelId` is the caller's
 * own string — `req.body.model` reaches here — and `KAANA_ROUTING_PROFILES` is an object
 * literal, so it inherits from `Object.prototype`. `KAANA_ROUTING_PROFILES['constructor']`
 * is the `Object` CONSTRUCTOR: truthy, so `|| null` never fires, and the
 * function returned an `RoutingProfile`-typed function for five identifiers no
 * caller registered. `toString`, `valueOf`, `hasOwnProperty` and `__proto__`
 * are the others.
 */
export function getRoutingProfile(modelId: string): RoutingProfile | null {
  return Object.hasOwn(KAANA_ROUTING_PROFILES, modelId) ? KAANA_ROUTING_PROFILES[modelId] : null;
}

/**
 * Check if a model ID is a Kaana routing profile.
 *
 * `in` walks the prototype chain, so this answered TRUE for those same five
 * identifiers. Passing one of those names as a profile could send an invalid
 * request into the Kaana boundary and surface a misleading availability error.
 */
export function isRoutingProfile(modelId: string): boolean {
  return Object.hasOwn(KAANA_ROUTING_PROFILES, modelId);
}

/**
 * Get model mappings for a tier.
 *
 * `RoutingTier` is a closed union, but `lib/gateway-client.ts` calls this through
 * `localGetMappings(tier as never)` with a plain `string`, so the type is not
 * the guard it looks like and the same inherited-property read applies.
 */
export function getModelMappingsForTier(tier: RoutingTier): ModelMapping[] {
  return Object.hasOwn(TIER_MODEL_MAPPINGS, tier) ? TIER_MODEL_MAPPINGS[tier] : [];
}

/**
 * Get all available Kaana routing profiles
 */
export function getAllRoutingProfiles(): RoutingProfile[] {
  return Object.values(KAANA_ROUTING_PROFILES);
}

/**
 * Get Kaana routing profiles by category
 */
export function getRoutingProfilesByCategory(category: ModelCategory): RoutingProfile[] {
  return Object.values(KAANA_ROUTING_PROFILES).filter(m => m.category === category);
}

/**
 * Get the default model for a category (lowest credit multiplier)
 */
export function getDefaultModelForCategory(category: ModelCategory): RoutingProfile | null {
  const models = getRoutingProfilesByCategory(category);
  if (models.length === 0) return null;
  return models.reduce((best, m) => m.creditMultiplier < best.creditMultiplier ? m : best);
}
