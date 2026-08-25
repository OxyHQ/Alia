/**
 * Model Mappings Generator
 *
 * This utility generates complete model mappings with capabilities and pricing
 * IMPORTANT: Only use REAL, currently available model IDs
 */

import type { ModelMapping } from './alia-models';
// The tier keys of the table below, from the tuple the database's CHECK
// constraints are rendered from — so a tier this table can serve is a tier a
// `model_configs` row may name.
import type { AliaTier } from './alia-tiers';
import type { ModelPublisher } from './model-publishers';
import { getModelCapabilities, getModelPricing } from './model-capabilities-data';

// Helper to create a model mapping with all required fields
export function createMapping(
  provider: string,
  publisher: ModelPublisher,
  model: string,
  modelId: string,
  priority: number,
  qualityScore: number
): ModelMapping {
  const pricing = getModelPricing(modelId);
  const capabilities = getModelCapabilities(modelId);

  return {
    provider,
    publisher,
    model,
    modelId,
    priority,
    qualityScore,
    pricingTier: pricing.tier,
    costPer1MInput: pricing.costPer1MInput,
    costPer1MOutput: pricing.costPer1MOutput,
    averageLatencyMs: pricing.averageLatencyMs,
    capabilities,
  };
}

// Generate all tier mappings - ONLY REAL MODEL IDS
export const GENERATED_TIER_MAPPINGS: Record<AliaTier, ModelMapping[]> = {
  'lite': [
    createMapping('google', 'google', 'gemini-2.5-flash', 'gemini-2.5-flash', 1, 75),
// Groq decommissioned the whole llama-3.3 line: MEASURED 2026-08-23, its
// catalogue lists neither `llama-3.3-70b-versatile` nor any llama id, and a
// request for one returns 404 `model_not_found`. It serves the gpt-oss pair,
// `qwen/qwen3.6-27b` and the compound systems.
    createMapping('groq', 'openai', 'gpt-oss-20b', 'openai/gpt-oss-20b', 2, 65),
    createMapping('deepseek', 'deepseek', 'deepseek-chat', 'deepseek-chat', 3, 72),
    createMapping('openai', 'openai', 'gpt-4o-mini', 'gpt-4o-mini', 4, 68),
    createMapping('novita', 'meta', 'llama-3.3-70b', 'meta-llama/llama-3.3-70b-instruct', 6, 60),
    createMapping('hyperbolic', 'deepseek', 'deepseek-v3', 'deepseek-ai/DeepSeek-V3', 7, 64),
    createMapping('sambanova', 'meta', 'llama-3.3-70b', 'Meta-Llama-3.3-70B-Instruct', 8, 62),
    createMapping('fireworks', 'deepseek', 'deepseek-v3', 'accounts/fireworks/models/deepseek-v3', 9, 63),
    createMapping('replicate', 'meta', 'llama-3.3-70b', 'meta/meta-llama-3.3-70b-instruct', 10, 63),
    createMapping('cohere', 'cohere', 'command-r7b-12-2024', 'command-r7b-12-2024', 11, 60),
    createMapping('cerebras', 'meta', 'llama-3.3-70b', 'llama-3.3-70b', 12, 62),
    createMapping('mistral', 'mistral', 'mistral-small-3.1', 'mistral-small-3.1-2503', 13, 58),
    createMapping('digitalocean', 'openai', 'gpt-5-nano', 'openai-gpt-5-nano', 14, 66),
    createMapping('digitalocean', 'meta', 'llama-3.3-70b', 'llama3.3-70b-instruct', 15, 63),
    createMapping('digitalocean', 'openai', 'gpt-oss-20b', 'openai-gpt-oss-20b', 16, 55),
    // OpenRouter last, and reachable: it is the one provider we hold spendable
    // credit for, and a provider with no key is refused before a request leaves
    // the process — so this serves today and steps aside the day a key above it
    // arrives. Model ids verified against openrouter.ai's live catalogue.
    createMapping('openrouter', 'openai', 'gpt-4o-mini', 'openai/gpt-4o-mini', 17, 76),
  ],
  'v1': [
    createMapping('google', 'google', 'gemini-2.5-flash', 'gemini-2.5-flash', 1, 88),
    createMapping('google', 'google', 'gemini-3-flash-preview', 'gemini-3-flash-preview', 2, 85),
    createMapping('deepseek', 'deepseek', 'deepseek-chat', 'deepseek-chat', 3, 83),
// Groq decommissioned the whole llama-3.3 line: MEASURED 2026-08-23, its
// catalogue lists neither `llama-3.3-70b-versatile` nor any llama id, and a
// request for one returns 404 `model_not_found`. It serves the gpt-oss pair,
// `qwen/qwen3.6-27b` and the compound systems.
    createMapping('groq', 'openai', 'gpt-oss-120b', 'openai/gpt-oss-120b', 5, 80),
    createMapping('openai', 'openai', 'gpt-4o-mini', 'gpt-4o-mini', 6, 82),
    createMapping('fireworks', 'deepseek', 'deepseek-v3', 'accounts/fireworks/models/deepseek-v3', 7, 79),
    createMapping('hyperbolic', 'deepseek', 'deepseek-v3', 'deepseek-ai/DeepSeek-V3', 8, 77),
    createMapping('sambanova', 'meta', 'llama-3.3-70b', 'Meta-Llama-3.3-70B-Instruct', 9, 76),
    createMapping('novita', 'meta', 'llama-3.3-70b', 'meta-llama/llama-3.3-70b-instruct', 10, 74),
    createMapping('replicate', 'meta', 'llama-3.3-70b', 'meta/meta-llama-3.3-70b-instruct', 11, 78),
    createMapping('cohere', 'cohere', 'command-r-08-2024', 'command-r-08-2024', 12, 75),
    createMapping('cerebras', 'meta', 'llama-3.3-70b', 'llama-3.3-70b', 13, 74),
    createMapping('mistral', 'mistral', 'mistral-small-3.1', 'mistral-small-3.1-2503', 14, 70),
    createMapping('digitalocean', 'openai', 'gpt-5-mini', 'openai-gpt-5-mini', 15, 80),
    createMapping('digitalocean', 'meta', 'llama-3.3-70b', 'llama3.3-70b-instruct', 16, 72),
    createMapping('digitalocean', 'alibaba', 'qwen3-32b', 'alibaba-qwen3-32b', 17, 70),
    // OpenRouter last, and reachable: it is the one provider we hold spendable
    // credit for, and a provider with no key is refused before a request leaves
    // the process — so this serves today and steps aside the day a key above it
    // arrives. Model ids verified against openrouter.ai's live catalogue.
    createMapping('openrouter', 'openai', 'gpt-4o', 'openai/gpt-4o', 18, 86),
  ],
  'v1-codea': [
    createMapping('deepseek', 'deepseek', 'deepseek-chat', 'deepseek-chat', 1, 94),
    createMapping('anthropic', 'anthropic', 'claude-sonnet-4', 'claude-sonnet-4-20250514', 2, 95),
    createMapping('google', 'google', 'gemini-3-flash-preview', 'gemini-3-flash-preview', 3, 93),
// Groq decommissioned the whole llama-3.3 line: MEASURED 2026-08-23, its
// catalogue lists neither `llama-3.3-70b-versatile` nor any llama id, and a
// request for one returns 404 `model_not_found`. It serves the gpt-oss pair,
// `qwen/qwen3.6-27b` and the compound systems.
    createMapping('groq', 'openai', 'gpt-oss-120b', 'openai/gpt-oss-120b', 5, 90),
    createMapping('google', 'google', 'gemini-2.5-pro', 'gemini-2.5-pro', 6, 92),
    createMapping('openai', 'openai', 'gpt-4o', 'gpt-4o', 7, 91),
    createMapping('fireworks', 'deepseek', 'deepseek-v3', 'accounts/fireworks/models/deepseek-v3', 8, 87),
    createMapping('replicate', 'meta', 'llama-3.1-405b', 'meta/meta-llama-3.1-405b-instruct', 9, 88),
    createMapping('cohere', 'cohere', 'command-a-03-2025', 'command-a-03-2025', 10, 86),
    createMapping('cerebras', 'meta', 'llama-3.3-70b', 'llama-3.3-70b', 11, 82),
    createMapping('mistral', 'mistral', 'mistral-small-3.1', 'mistral-small-3.1-2503', 12, 78),
    createMapping('digitalocean', 'openai', 'gpt-5', 'openai-gpt-5', 13, 90),
    createMapping('digitalocean', 'openai', 'gpt-5.1-codex-max', 'openai-gpt-5.1-codex-max', 14, 89),
    // OpenRouter last, and reachable: it is the one provider we hold spendable
    // credit for, and a provider with no key is refused before a request leaves
    // the process — so this serves today and steps aside the day a key above it
    // arrives. Model ids verified against openrouter.ai's live catalogue.
    createMapping('openrouter', 'anthropic', 'claude-sonnet-4', 'anthropic/claude-sonnet-4', 15, 88),
  ],
  'v1-cowork': [
    createMapping('deepseek', 'deepseek', 'deepseek-chat', 'deepseek-chat', 1, 93),
    createMapping('anthropic', 'anthropic', 'claude-sonnet-4', 'claude-sonnet-4-20250514', 2, 95),
    createMapping('google', 'google', 'gemini-2.5-pro', 'gemini-2.5-pro', 3, 92),
    createMapping('openai', 'openai', 'gpt-4o', 'gpt-4o', 4, 90),
// Groq decommissioned the whole llama-3.3 line: MEASURED 2026-08-23, its
// catalogue lists neither `llama-3.3-70b-versatile` nor any llama id, and a
// request for one returns 404 `model_not_found`. It serves the gpt-oss pair,
// `qwen/qwen3.6-27b` and the compound systems.
    createMapping('groq', 'openai', 'gpt-oss-120b', 'openai/gpt-oss-120b', 6, 87),
    createMapping('replicate', 'meta', 'llama-3.3-70b', 'meta/meta-llama-3.3-70b-instruct', 7, 85),
    createMapping('cohere', 'cohere', 'command-a-03-2025', 'command-a-03-2025', 8, 83),
    createMapping('cerebras', 'meta', 'llama-3.3-70b', 'llama-3.3-70b', 9, 80),
    createMapping('mistral', 'mistral', 'mistral-small-3.1', 'mistral-small-3.1-2503', 10, 76),
    createMapping('digitalocean', 'openai', 'gpt-5', 'openai-gpt-5', 11, 88),
  ],
  'v1-browser': [
    createMapping('google', 'google', 'gemini-3-flash-preview', 'gemini-3-flash-preview', 1, 97),
    createMapping('anthropic', 'anthropic', 'claude-sonnet-4', 'claude-sonnet-4-20250514', 2, 96),
    createMapping('google', 'google', 'gemini-2.5-pro', 'gemini-2.5-pro', 3, 94),
    createMapping('perplexity', 'perplexity', 'sonar-pro', 'sonar-pro', 4, 93),
    createMapping('deepseek', 'deepseek', 'deepseek-chat', 'deepseek-chat', 5, 92),
// Groq decommissioned the whole llama-3.3 line: MEASURED 2026-08-23, its
// catalogue lists neither `llama-3.3-70b-versatile` nor any llama id, and a
// request for one returns 404 `model_not_found`. It serves the gpt-oss pair,
// `qwen/qwen3.6-27b` and the compound systems.
    createMapping('groq', 'openai', 'gpt-oss-120b', 'openai/gpt-oss-120b', 7, 89),
    createMapping('openai', 'openai', 'gpt-4o', 'gpt-4o', 8, 90),
    createMapping('replicate', 'meta', 'llama-3.3-70b', 'meta/meta-llama-3.3-70b-instruct', 9, 87),
    createMapping('cloudflare', 'meta', 'llama-3.2-11b-vision', '@cf/meta/llama-3.2-11b-vision-instruct', 10, 86),
    createMapping('cerebras', 'meta', 'llama-3.3-70b', 'llama-3.3-70b', 11, 82),
    createMapping('mistral', 'mistral', 'mistral-small-3.1', 'mistral-small-3.1-2503', 12, 78),
    createMapping('digitalocean', 'openai', 'gpt-5-mini', 'openai-gpt-5-mini', 13, 80),
  ],
  'v1-vision': [
    createMapping('google', 'google', 'gemini-3-flash-preview', 'gemini-3-flash-preview', 1, 97),
    createMapping('google', 'google', 'gemini-2.5-pro', 'gemini-2.5-pro', 2, 96),
    createMapping('anthropic', 'anthropic', 'claude-sonnet-4', 'claude-sonnet-4-20250514', 3, 95),
    createMapping('openai', 'openai', 'gpt-4o', 'gpt-4o', 4, 92),
    createMapping('xai', 'xai', 'grok-4.6', 'grok-4.6', 5, 90),
    createMapping('cloudflare', 'meta', 'llama-3.2-11b-vision', '@cf/meta/llama-3.2-11b-vision-instruct', 6, 88),
    createMapping('cohere', 'cohere', 'command-a-vision-07-2025', 'command-a-vision-07-2025', 7, 87),
    createMapping('digitalocean', 'openai', 'gpt-4o', 'openai-gpt-4o', 8, 90),
    // OpenRouter last, and reachable: it is the one provider we hold spendable
    // credit for, and a provider with no key is refused before a request leaves
    // the process — so this serves today and steps aside the day a key above it
    // arrives. Model ids verified against openrouter.ai's live catalogue.
    createMapping('openrouter', 'openai', 'gpt-4o', 'openai/gpt-4o', 9, 86),
  ],
  'v1-audio': [
    createMapping('groq', 'openai', 'whisper-large-v3-turbo', 'whisper-large-v3-turbo', 1, 95),
    createMapping('groq', 'openai', 'whisper-large-v3', 'whisper-large-v3', 2, 93),
    createMapping('openai', 'openai', 'whisper-1', 'whisper-1', 3, 92),
  ],
  'v1-tts': [
    // OpenAI stays highest priority so an added OpenAI key is preferred. Google
    // Gemini TTS runs on the same keys chat uses, so it is the primary working
    // provider today; DigitalOcean ElevenLabs backs it up. (OpenRouter serves no
    // TTS endpoint — it 400s — so it is intentionally not in the chain.)
    // ElevenLabs DIRECT is first because its key is a free monthly quota, and
    // `key-manager.ts` already prefers a free key over a paid one — ranking it
    // here is the same preference expressed one level up, where the choice is
    // between providers rather than between keys of one provider.
    createMapping('elevenlabs', 'elevenlabs', 'eleven-multilingual-v2', 'eleven_multilingual_v2', 1, 96),
    createMapping('openai', 'openai', 'tts-1', 'tts-1', 2, 90),
    createMapping('openai', 'openai', 'tts-1-hd', 'tts-1-hd', 3, 95),
    createMapping('google', 'google', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-preview-tts', 4, 88),
    createMapping('digitalocean', 'elevenlabs', 'eleven-multilingual-v2', 'fal-ai/elevenlabs/tts/multilingual-v2', 5, 87),
    // LAST, and deliberately so, though it is the only model here that can
    // perform an audio tag. It shares the ElevenLabs key with the v2 entry
    // above but is not priced like it, and this tier serves read-aloud as well
    // as shows — ranking it first would move every ordinary sentence a user
    // asks to have read onto a model chosen for a capability that sentence
    // does not use. `synthesize-speech.ts` promotes it for the only requests
    // that need it: the ones whose line actually carries a tag. For every
    // other request this chain resolves exactly as it did before it existed.
    createMapping('elevenlabs', 'elevenlabs', 'eleven-v3', 'eleven_v3', 6, 97),
  ],
  /**
   * Sound EFFECTS — the non-speech audio a show's script asks for.
   *
   * A tier rather than a hardcoded call, and that is the whole fix. The show
   * pipeline named `digitalocean` / `fal-ai/stable-audio-25/text-to-audio`
   * inline as its ONLY route, so the chain was exhausted on the first attempt
   * and every sound cue in every episode was lost. MEASURED in production on
   * 2026-08-24 and again on 2026-08-25: three `no_credential` failures per
   * episode, `provider_keys` holds no `digitalocean` row at all, and the
   * episodes published without a single effect.
   *
   * ElevenLabs leads for the same reason it leads `v1-tts` — its key is a free
   * monthly quota and `key-manager.ts` prefers a free key. MEASURED 2026-08-25
   * with that key: `POST /v1/sound-generation` answers 200 `audio/mpeg`, 81 kB
   * in 2.7 s for v2 and 48 kB in 1.7 s for v3.
   *
   * ## HOW DEEP THIS CHAIN ACTUALLY IS, which is not the same as how long it is
   *
   * Three entries, TWO providers, and in production today exactly ONE of those
   * providers can serve. `provider_keys` holds four rows — `elevenlabs`,
   * `groq`, `openrouter`, `xai` — and none for `digitalocean`, so the fal entry
   * is refused at `getBestKeyForModel` before a request leaves the process.
   * Against the failure that matters most, the ElevenLabs key being exhausted
   * or revoked, the effective depth is one and this chain buys nothing.
   *
   * That is worth stating rather than letting three lines imply resilience they
   * do not have. What each entry really covers:
   *
   *  - `eleven_text_to_sound_v3` covers a MODEL fault — v2 deprecated, or a
   *    prompt v2 refuses. It shares v2's credential, so it covers no key fault.
   *    Measured, not assumed: the endpoint's own 422 names these two ids as the
   *    only ones it accepts, and both answer 200 on our key.
   *  - the fal entry covers a PROVIDER fault, and is the only entry that does —
   *    the day a DigitalOcean key exists.
   *
   * There is no fourth option to add without a new provider integration, which
   * is Kaana's to own and not Alia's: of the providers `callProviderAPI` can
   * already reach, OpenAI and Groq serve speech and transcription but no
   * text-to-audio, OpenRouter serves no audio endpoint at all (it 400s, as the
   * `v1-tts` comment records), and Google's branch here is Gemini TTS. So the
   * honest state is a chain whose depth is one credential away from real, and
   * the thing that makes it real is an operator's, not a commit's.
   */
  'v1-sfx': [
    createMapping('elevenlabs', 'elevenlabs', 'eleven-text-to-sound-v2', 'eleven_text_to_sound_v2', 1, 92),
    createMapping('elevenlabs', 'elevenlabs', 'eleven-text-to-sound-v3', 'eleven_text_to_sound_v3', 2, 90),
    createMapping('digitalocean', 'stability', 'stable-audio-25', 'fal-ai/stable-audio-25/text-to-audio', 3, 85),
  ],
  'v1-image': [
    createMapping('openai', 'openai', 'dall-e-3', 'dall-e-3', 1, 92),
    createMapping('digitalocean', 'openai', 'gpt-image-1', 'openai-gpt-image-1', 2, 90),
    createMapping('digitalocean', 'black-forest-labs', 'flux-schnell', 'fal-ai/flux/schnell', 3, 85),
    createMapping('digitalocean', 'stability', 'sdxl', 'fal-ai/fast-sdxl', 4, 80),
    // Last, so an added OpenAI or DigitalOcean key still wins — the same
    // convention `v1-tts` states. It costs nothing to rank it here: a provider
    // holding no key is refused before a request leaves the process.
    // MEASURED 2026-08-23: this is currently the ONLY image mapping that can
    // serve, and it needs `image-providers.ts` to strip `size` and `quality`.
    createMapping('xai', 'xai', 'grok-imagine-image', 'grok-imagine-image', 5, 84),
  ],
  'v1-multimodal': [
    createMapping('google', 'google', 'gemini-3-pro-preview', 'gemini-3-pro-preview', 1, 99),
    createMapping('google', 'google', 'gemini-2.5-pro', 'gemini-2.5-pro', 2, 98),
    createMapping('anthropic', 'anthropic', 'claude-opus-4', 'claude-opus-4-20241120', 3, 97),
    createMapping('google', 'google', 'gemini-3-flash-preview', 'gemini-3-flash-preview', 4, 96),
    createMapping('openai', 'openai', 'gpt-4o', 'gpt-4o', 5, 95),
    createMapping('cloudflare', 'meta', 'llama-3.2-11b-vision', '@cf/meta/llama-3.2-11b-vision-instruct', 6, 90),
    // OpenRouter last, and reachable: it is the one provider we hold spendable
    // credit for, and a provider with no key is refused before a request leaves
    // the process — so this serves today and steps aside the day a key above it
    // arrives. Model ids verified against openrouter.ai's live catalogue.
    createMapping('openrouter', 'google', 'gemini-2.5-pro', 'google/gemini-2.5-pro', 7, 90),
  ],
  'v1-pro': [
    createMapping('anthropic', 'anthropic', 'claude-sonnet-4', 'claude-sonnet-4-20250514', 1, 96),
    createMapping('google', 'google', 'gemini-2.5-pro', 'gemini-2.5-pro', 2, 95),
    createMapping('deepseek', 'deepseek', 'deepseek-reasoner', 'deepseek-reasoner', 3, 94),
    createMapping('xai', 'xai', 'grok-4.3', 'grok-4.3', 4, 93),
    createMapping('openai', 'openai', 'o1', 'o1', 5, 92),
    createMapping('cohere', 'cohere', 'command-a-reasoning-08-2025', 'command-a-reasoning-08-2025', 6, 91),
    createMapping('perplexity', 'perplexity', 'sonar-reasoning-pro', 'sonar-reasoning-pro', 7, 89),
    createMapping('digitalocean', 'anthropic', 'claude-sonnet-4.6', 'anthropic-claude-4.6-sonnet', 8, 94),
    createMapping('digitalocean', 'openai', 'o3', 'openai-o3', 9, 92),
    createMapping('digitalocean', 'openai', 'gpt-5.2', 'openai-gpt-5.2', 10, 90),
    // OpenRouter last, and reachable: it is the one provider we hold spendable
    // credit for, and a provider with no key is refused before a request leaves
    // the process — so this serves today and steps aside the day a key above it
    // arrives. Model ids verified against openrouter.ai's live catalogue.
    createMapping('openrouter', 'anthropic', 'claude-sonnet-4', 'anthropic/claude-sonnet-4', 11, 90),
  ],
  'v1-pro-max': [
    createMapping('anthropic', 'anthropic', 'claude-opus-4', 'claude-opus-4-20241120', 1, 98),
    createMapping('google', 'google', 'gemini-2.5-pro', 'gemini-2.5-pro', 2, 96),
    createMapping('openai', 'openai', 'o1', 'o1', 3, 95),
    createMapping('xai', 'xai', 'grok-4.6', 'grok-4.6', 4, 94),
    createMapping('deepseek', 'deepseek', 'deepseek-reasoner', 'deepseek-reasoner', 5, 94),
    createMapping('cohere', 'cohere', 'command-a-reasoning-08-2025', 'command-a-reasoning-08-2025', 6, 91),
    createMapping('digitalocean', 'anthropic', 'claude-opus-4.6', 'anthropic-claude-opus-4.6', 7, 96),
    createMapping('digitalocean', 'openai', 'o1', 'openai-o1', 8, 93),
    createMapping('digitalocean', 'openai', 'gpt-5.2-pro', 'openai-gpt-5.2-pro', 9, 92),
    // OpenRouter last, and reachable: it is the one provider we hold spendable
    // credit for, and a provider with no key is refused before a request leaves
    // the process — so this serves today and steps aside the day a key above it
    // arrives. Model ids verified against openrouter.ai's live catalogue.
    createMapping('openrouter', 'anthropic', 'claude-opus-4', 'anthropic/claude-opus-4', 10, 92),
  ],
  'v1-voice': [
    {
      provider: 'xai',
      publisher: 'xai' as const,
      model: 'grok-realtime' as const,
      modelId: 'grok-realtime',
      priority: 1,
      qualityScore: 85,
      pricingTier: 'paid' as const,
      costPerMinute: 0.05,
      capabilities: {
        voice: true,
        audio: true,
        // A realtime voice model, not a TTS one: it is never handed a written
        // line to read, so there is no bracketed cue for it to perform.
        audioTags: false,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 32768,
        maxOutputTokens: 8192,
      },
    },
    {
      provider: 'openai',
      publisher: 'openai' as const,
      model: 'gpt-4o-realtime-preview' as const,
      modelId: 'gpt-4o-realtime-preview',
      priority: 2,
      qualityScore: 90,
      pricingTier: 'paid' as const,
      costPerMinute: 0.06,
      capabilities: {
        voice: true,
        audio: true,
        // A realtime voice model, not a TTS one: it is never handed a written
        // line to read, so there is no bracketed cue for it to perform.
        audioTags: false,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
      },
    },
  ],
  'v1-voice-pro': [
    {
      provider: 'openai',
      publisher: 'openai' as const,
      model: 'gpt-4o-realtime-preview' as const,
      modelId: 'gpt-4o-realtime-preview',
      priority: 1,
      qualityScore: 90,
      pricingTier: 'paid' as const,
      costPerMinute: 0.06,
      capabilities: {
        voice: true,
        audio: true,
        // A realtime voice model, not a TTS one: it is never handed a written
        // line to read, so there is no bracketed cue for it to perform.
        audioTags: false,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
      },
    },
    {
      provider: 'xai',
      publisher: 'xai' as const,
      model: 'grok-realtime' as const,
      modelId: 'grok-realtime',
      priority: 2,
      qualityScore: 85,
      pricingTier: 'paid' as const,
      costPerMinute: 0.05,
      capabilities: {
        voice: true,
        audio: true,
        // A realtime voice model, not a TTS one: it is never handed a written
        // line to read, so there is no bracketed cue for it to perform.
        audioTags: false,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 32768,
        maxOutputTokens: 8192,
      },
    },
  ],
};
