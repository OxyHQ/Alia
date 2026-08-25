/**
 * Model Resolver
 *
 * Resolves Alia model IDs to concrete provider/model combinations.
 * Delegates to the fallback engine for smart retry logic, key cooldown,
 * and analytics recording.
 *
 * The public API (resolveAliaModel) remains backward-compatible.
 */

import type { KeyConfig } from './types';
import {
  ALIA_MODELS,
  isAliaModel,
  getAliaModel,
  type AliaModel,
} from './alia-models';
import { resolveWithFallback, type FallbackOptions, type FallbackResult, type FallbackAttempt } from './fallback-engine';

export interface ResolvedModel {
  aliasModelId: string;
  provider: string;
  /**
   * Who RELEASED the model that answered, carried through from the mapping.
   *
   * Beside `provider` rather than derived from it, because they are different
   * questions with different answers — `{provider: 'digitalocean', publisher:
   * 'anthropic'}` is a real row. The pair is what `lib/reasoning-effort.ts`
   * keys on to decide whether this route can carry a reasoning option at all.
   */
  publisher: string;
  /** The publisher's own name for it, which is NOT {@link modelId}. */
  model: string;
  modelId: string;
  keyConfig: KeyConfig;
  aliaModel: AliaModel;
  isFallback: boolean;
  fallbackIndex: number;
}

/**
 * Resolve an Alia model ID to a concrete provider and model.
 *
 * Keys are loaded from the `provider_keys` PostgreSQL table via key-manager.
 * Uses the fallback engine for smart retry logic based on error classification.
 *
 * @param requestedModel - A registered Alia model ID; anything else is refused
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Optional set of providers to skip (for retry scenarios)
 * @param skipKeyIds - Specific key IDs to skip (for retry scenarios)
 * @param options - Per-request routing options; omitted means today's behaviour
 * @returns Resolved model with key config, or null if no models available
 */
export async function resolveAliaModel(
  requestedModel: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds: Set<string> = new Set(),
  options: FallbackOptions = {}
): Promise<ResolvedModel | null> {
  const result = await resolveWithFallback(requestedModel, tokens, skipProviders, skipKeyIds, options);
  return result.resolved;
}

/**
 * Extended resolution that returns the full fallback result including attempt history.
 * Use this when you need access to fallback analytics (e.g., for logging or debugging).
 *
 * @param requestedModel - The model ID requested
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Optional set of providers to skip
 * @param skipKeyIds - Specific key IDs to skip (for retry scenarios)
 * @param options - Per-request routing options; omitted means today's behaviour
 * @returns Full FallbackResult with resolved model, attempts, and metadata
 */
export async function resolveAliaModelWithAttempts(
  requestedModel: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds: Set<string> = new Set(),
  options: FallbackOptions = {}
): Promise<FallbackResult> {
  return resolveWithFallback(requestedModel, tokens, skipProviders, skipKeyIds, options);
}

/*
 * There is deliberately NO `getDefaultAliaModel` here.
 *
 * This file used to export one returning `alia-v1`, alongside the live one in
 * `lib/gateway-client.ts` returning `alia-lite`. Nothing imported this copy —
 * `gateway-client.ts` destructures only `resolveAliaModel` from this module —
 * so it was a second answer to "what does a request with no model get" that was
 * never returned to anyone, and it disagreed with the answer that was.
 *
 * Which model a request defaults to is a PRODUCT decision, and `internal/
 * providers/` is the routing tree ADR 0001 moves to Relay. A default declared
 * here would migrate with the routing and leave the product without one.
 * `defaultChatModel.test.ts` asserts this module declares no default.
 *
 * `isValidModel` went with it: also unimported, and a one-line alias for the
 * `isAliaModel` re-exported two lines below.
 */

// Re-export utilities from alia-models
export { isAliaModel, getAliaModel, ALIA_MODELS, type AliaModel };

// Re-export fallback types for consumers
export type { FallbackOptions, FallbackResult, FallbackAttempt };
