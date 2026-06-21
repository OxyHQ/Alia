/**
 * Alia model vocabulary — the user-facing, provider-agnostic types that
 * describe Alia's branded model catalog.
 *
 * These types are intentionally Alia-branded only: they never reference
 * internal provider names or provider model IDs (model abstraction is
 * non-negotiable). The canonical definitions live here so the API, gateway,
 * and any other consumer share one source of truth instead of maintaining
 * drifting copies. The runtime catalog itself (`ALIA_MODELS`) and the internal
 * provider-routing tables remain inside the API's `internal/` boundary.
 */

/**
 * Alia model tiers exposed to users (e.g. `alia-lite`, `alia-v1`,
 * `alia-v1-pro`). This is the canonical superset across all Alia surfaces.
 */
export type AliaTier =
  | 'lite'
  | 'v1'
  | 'v1-codea'
  | 'v1-cowork'
  | 'v1-browser'
  | 'v1-vision'
  | 'v1-audio'
  | 'v1-tts'
  | 'v1-image'
  | 'v1-multimodal'
  | 'v1-pro'
  | 'v1-pro-max'
  | 'v1-voice'
  | 'v1-voice-pro';

/** High-level category a model is optimized for. */
export type ModelCategory = 'general' | 'coding' | 'vision' | 'audio' | 'multimodal' | 'voice';

/** Billing tier surfaced for an Alia model. */
export type PricingTier = 'free' | 'freemium' | 'paid';

/** Capability flags advertised for an Alia model. */
export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  video: boolean;
  /** Real-time voice conversations. */
  voice: boolean;
  tools: boolean;
  /** Built-in code execution. */
  codeExecution: boolean;
  /** Built-in web search. */
  webSearch: boolean;
  /** Computer-use / desktop control. */
  computerUse: boolean;
  streaming: boolean;
  systemPrompts: boolean;
  functionCalling: boolean;
  /** Prompt-caching support. */
  promptCaching: boolean;
  /** Maximum context window in tokens (e.g. 8k, 128k, 1M). */
  maxContextTokens: number;
  maxOutputTokens: number;
}

/** A user-facing Alia model definition. */
export interface AliaModel {
  id: string;
  name: string;
  tier: AliaTier;
  description: string;
  creditMultiplier: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  category: ModelCategory;
  emoji?: string;
  chatVisible?: boolean;
}
