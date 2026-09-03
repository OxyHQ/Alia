/**
 * Chat Core - Shared logic for all chat endpoints
 *
 * Resolves Alia product profiles to Kaana and preserves the user-runtime bridge.
 */

import { createOpenAI } from '@ai-sdk/openai';

import { getOxyKaanaRoutingProfileId } from '../config/oxy-inference-routing-profile-ids.js';
import { USER_RUNTIME_PROVIDER, userRuntimeFetch } from './inference/user-runtime-bridge.js';
import { kaanaLanguageModel } from './inference/kaana-language-model.js';
import type { AliaInferenceSurface } from './inference/product-seam.js';
import { formatModelIdentity } from './routing/model-identity.js';
import { UnregisteredModelError } from './routing/policy.js';
import { assertUnreservedModelIdentifier } from './reserved-namespace.js';
import {
  getDefaultRoutingProfile,
  isRoutingProfile,
  getRoutingProfile,
  getAllRoutingProfiles,
  getRoutingProfilesByCategory,
  getDefaultModelForCategory,
  getAvailableModels,
  type KeyConfig,
  type RoutingProfile,
  type RoutingProfileWithAvailability,
  type ModelCategory,
  type RoutingOptions,
} from './gateway-client.js';

// Re-export types and helpers that chat routes need
export { getDefaultRoutingProfile, isRoutingProfile, getRoutingProfile, getAllRoutingProfiles, getRoutingProfilesByCategory, getDefaultModelForCategory, getAvailableModels };
export type { KeyConfig, RoutingProfile, RoutingProfileWithAvailability, ModelCategory, RoutingOptions };

/**
 * The compatibility shape consumed by Alia's chat orchestration. Hosted
 * resolutions contain no provider credential: Kaana is the only destination.
 */
export interface ResolvedModel {
  routingProfileId: string;
  provider: string;
  /** Who RELEASED the model that answered. Never who serves it. */
  publisher: string;
  /** The publisher's own name for it, which is NOT {@link modelId}. */
  model: string;
  modelId: string;
  keyConfig: KeyConfig;
  /**
   * The routing profile or pinned model to send Kaana. It is `null` only for a
   * user-runtime model, which Kaana cannot reach by construction.
   */
  oxyInferenceTarget:
    | { readonly kind: 'routing_profile_id'; readonly routingProfileId: string }
    | { readonly kind: 'model'; readonly model: string }
    | null;
  routingProfile: RoutingProfile;
  isFallback: boolean;
  fallbackIndex?: number;
}

/**
 * Resolve an Alia product profile to Kaana.
 *
 * @param routingProfileId - Alia's product profile ID (e.g., "kaana-v1", "kaana-lite")
 * @param options - Per-request routing options, including an optional model pin
 * @returns A credential-free Kaana resolution
 * @throws UnregisteredModelError when `routingProfileId` names no registered model
 * @throws FallbackNotPermittedError when a non-default policy exhausts its candidates
 */
export async function resolveModel(
  routingProfileId: string,
  _skipProviders?: Set<string>,
  _skipKeyIds?: Set<string>,
  options?: RoutingOptions
): Promise<ResolvedModel | null> {
  assertUnreservedModelIdentifier(routingProfileId);
  const models = await getAllRoutingProfiles();
  const routingProfile = models.find((model) => model.id === routingProfileId);
  if (routingProfile === undefined) {
    throw new UnregisteredModelError(routingProfileId, models.map((model) => model.id));
  }

  const target = options?.pinnedModel === undefined
    ? (() => {
        const oxyRoutingProfileId = getOxyKaanaRoutingProfileId(routingProfileId);
        if (oxyRoutingProfileId === null) {
          throw new UnregisteredModelError(
            routingProfileId,
            models
              .map((model) => model.id)
              .filter((id) => getOxyKaanaRoutingProfileId(id) !== null),
          );
        }
        return { kind: 'routing_profile_id' as const, routingProfileId: oxyRoutingProfileId };
      })()
    : { kind: 'model' as const, model: formatModelIdentity(options.pinnedModel) };
  const productModelId = target.kind === 'model' ? target.model : routingProfileId;

  return {
    routingProfileId,
    provider: 'kaana',
    publisher: 'kaana',
    model: productModelId,
    modelId: productModelId,
    keyConfig: { provider: 'kaana', modelId: productModelId },
    oxyInferenceTarget: target,
    routingProfile,
    isFallback: false,
  };
}

/**
 * Create the AI SDK model for Kaana or the caller's own machine.
 */
export function getAIModel(
  resolved: ResolvedModel,
  surface: AliaInferenceSurface,
  oxyUserId?: string,
  serviceToken?: string,
) {
  if (resolved.provider === USER_RUNTIME_PROVIDER) {
    const binding = resolved.keyConfig.userRuntime;
    if (!binding) throw new Error('A user-runtime route arrived without a device binding');
    const runtime = createOpenAI({
      apiKey: '',
      baseURL: 'http://user-runtime.invalid/v1',
      fetch: userRuntimeFetch(binding),
    });
    return runtime.chat(resolved.modelId);
  }

  const target = resolved.oxyInferenceTarget;
  if (target === null) {
    throw new Error('A hosted inference route arrived without an Oxy inference target');
  }
  return kaanaLanguageModel({
    target,
    modelId: resolved.modelId,
    surface,
    ...(oxyUserId === undefined ? {} : { oxyUserId }),
    ...(serviceToken === undefined ? {} : { serviceToken }),
  });
}
