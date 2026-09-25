/**
 * Chat Core - Shared logic for all chat endpoints
 *
 * Resolves a real `publisher/model` from Oxy's catalogue to Kaana (ADR 0012),
 * and preserves the user-runtime bridge for models on the caller's own device.
 */

import { createOpenAI } from '@ai-sdk/openai';

import { USER_RUNTIME_PROVIDER, userRuntimeFetch } from './inference/user-runtime-bridge.js';
import { kaanaLanguageModel } from './inference/kaana-language-model.js';
import type { AliaInferenceSurface } from './inference/product-seam.js';
import { assertUnreservedModelIdentifier } from './reserved-namespace.js';
import { isChatUsable, listCatalogueModels, type CatalogueModel, type ReasoningEffort } from './models/catalogue.js';
import { ModelNotFoundError } from './models/errors.js';
import { getDefaultModelId, getUtilityModelId } from './models/selection.js';
import type { KeyConfig } from './gateway-client.js';

export type { KeyConfig };

/**
 * A model a turn runs on. Hosted resolutions carry no provider credential:
 * Kaana, through Oxy, is the only destination.
 */
export interface ResolvedModel {
  /** `publisher/model` for a hosted model; the runtime's own tag for a local one. */
  modelId: string;
  provider: string;
  /** Who RELEASED the model. Never who serves it. */
  publisher: string;
  /** The publisher's own name for it. */
  model: string;
  keyConfig: KeyConfig;
  /** What Oxy is asked for; `null` only for a user-runtime model. */
  oxyInferenceTarget: { readonly kind: 'model'; readonly model: string } | null;
  /** The catalogue entry; `null` for a user-runtime model. */
  catalogue: CatalogueModel | null;
}

function hosted(model: CatalogueModel): ResolvedModel {
  return {
    modelId: model.id,
    provider: 'kaana',
    publisher: model.publisher.id,
    model: model.id.slice(model.id.indexOf('/') + 1),
    keyConfig: { provider: 'kaana', modelId: model.id },
    oxyInferenceTarget: { kind: 'model', model: model.id },
    catalogue: model,
  };
}

/**
 * Resolve a `publisher/model` against the live catalogue.
 *
 * @throws ModelNotFoundError when the catalogue offers no chat-usable model by
 *   that exact id.
 */
export async function resolveModel(modelId: string): Promise<ResolvedModel> {
  assertUnreservedModelIdentifier(modelId);
  const model = (await listCatalogueModels()).find((entry) => entry.id === modelId);
  if (model === undefined || !isChatUsable(model)) throw new ModelNotFoundError(modelId);
  return hosted(model);
}

/** The model a request that names none runs on, for this person. */
export async function resolveDefaultModel(oxyUserId?: string | null): Promise<ResolvedModel> {
  return resolveModel(await getDefaultModelId(oxyUserId));
}

/**
 * The model for Alia's own background calls — titles, summaries, compaction,
 * suggestions, planning, verification. Chosen from the catalogue, never named.
 */
export async function resolveUtilityModel(): Promise<ResolvedModel> {
  return resolveModel(await getUtilityModelId());
}

/**
 * A stored model preference (an agent's, a thread's, a bot's), or the default
 * when it is unset or no longer offered.
 */
export async function resolveStoredModel(
  modelId: string | null | undefined,
  oxyUserId?: string | null,
): Promise<ResolvedModel> {
  if (modelId) {
    try {
      return await resolveModel(modelId);
    } catch (error) {
      if (!(error instanceof ModelNotFoundError)) throw error;
    }
  }
  return resolveDefaultModel(oxyUserId);
}

export interface AIModelOptions {
  /** Forwarded to Oxy as `reasoning: { effort }` for a hosted model. */
  readonly reasoningEffort?: ReasoningEffort | null;
}

/**
 * Create the AI SDK model for Kaana or the caller's own machine.
 */
export function getAIModel(
  resolved: ResolvedModel,
  surface: AliaInferenceSurface,
  oxyUserId?: string,
  serviceToken?: string,
  options: AIModelOptions = {},
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
    ...(options.reasoningEffort == null ? {} : { reasoningEffort: options.reasoningEffort }),
  });
}
