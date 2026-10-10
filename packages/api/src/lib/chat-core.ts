/**
 * Chat Core - Shared logic for all chat endpoints
 *
 * Resolves what a turn runs on — a power level (ADR 0014) or a real
 * `publisher/model` from Oxy's catalogue (ADR 0012) — to Kaana through Oxy, and
 * preserves the user-runtime bridge for models on the caller's own device.
 */

import { createOpenAI } from '@ai-sdk/openai';

import { USER_RUNTIME_PROVIDER, userRuntimeFetch } from './inference/user-runtime-bridge.js';
import { kaanaLanguageModel } from './inference/kaana-language-model.js';
import type { AliaInferenceSurface } from './inference/product-seam.js';
import { assertUnreservedModelIdentifier } from './reserved-namespace.js';
import {
  isChatUsable,
  listCatalogueModels,
  type CatalogueModel,
  type ReasoningEffort,
} from './models/catalogue.js';
import { ModelNotFoundError } from './models/errors.js';
import { getUtilityModelId } from './models/selection.js';
import {
  DEFAULT_POWER_LEVEL,
  isPowerLevel,
  type OxyInferenceTarget,
  type PowerLevel,
} from './models/power-levels.js';
import type { KeyConfig } from './gateway-client.js';

export type { KeyConfig };
export type { OxyInferenceTarget };

/**
 * A model a turn runs on. Hosted resolutions carry no provider credential:
 * Kaana, through Oxy, is the only destination.
 */
export interface ResolvedModel {
  /**
   * `publisher/model` for a hosted model, the level's slug for a power level,
   * the runtime's own tag for a local one.
   */
  modelId: string;
  provider: string;
  /** Who RELEASED the model. Never who serves it. */
  publisher: string;
  /** The publisher's own name for it. */
  model: string;
  keyConfig: KeyConfig;
  /** What Oxy is asked for; `null` only for a user-runtime model. */
  oxyInferenceTarget: OxyInferenceTarget | null;
  /**
   * The catalogue entry; `null` for a power level (the model is Oxy's choice,
   * per request) and for a user-runtime model.
   */
  catalogue: CatalogueModel | null;
  /** The power level this turn runs at, or `null` for an exact model. */
  powerLevel: PowerLevel | null;
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
    powerLevel: null,
  };
}

/** A power level: Oxy chooses the model of that level for each request. */
export function powerLevelResolution(level: PowerLevel): ResolvedModel {
  return {
    modelId: level,
    provider: 'kaana',
    publisher: 'oxy',
    model: level,
    keyConfig: { provider: 'kaana', modelId: level },
    oxyInferenceTarget: { kind: 'routingProfile', routingProfile: level },
    catalogue: null,
    powerLevel: level,
  };
}

/**
 * Resolve a power level, or a `publisher/model` against the live catalogue.
 *
 * @throws ModelNotFoundError when the id is neither a power level nor a
 *   chat-usable model in the catalogue.
 */
export async function resolveModel(modelId: string): Promise<ResolvedModel> {
  if (isPowerLevel(modelId)) return powerLevelResolution(modelId);
  assertUnreservedModelIdentifier(modelId);
  const model = (await listCatalogueModels()).find((entry) => entry.id === modelId);
  if (model === undefined || !isChatUsable(model)) throw new ModelNotFoundError(modelId);
  return hosted(model);
}

/**
 * What a request that names nothing runs on: the `auto` power level (ADR 0014).
 * Oxy picks the cheapest level that suffices for each request.
 */
export function resolveDefaultModel(): ResolvedModel {
  return powerLevelResolution(DEFAULT_POWER_LEVEL);
}

/**
 * The model for Alia's own background calls — titles, summaries, compaction,
 * suggestions, planning, verification. Chosen from the catalogue, never named.
 */
export async function resolveUtilityModel(): Promise<ResolvedModel> {
  return resolveModel(await getUtilityModelId());
}

/**
 * A stored preference (an agent's, a thread's, a bot's) — a power level or a
 * model — or the default when it is unset or no longer offered.
 */
export async function resolveStoredModel(
  modelId: string | null | undefined,
): Promise<ResolvedModel> {
  if (modelId) {
    try {
      return await resolveModel(modelId);
    } catch (error) {
      if (!(error instanceof ModelNotFoundError)) throw error;
    }
  }
  return resolveDefaultModel();
}

export interface AIModelOptions {
  readonly onInferenceRequest?: import('./inference/kaana-language-model.js').KaanaModelOptions['onInferenceRequest'];
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
    ...(options.onInferenceRequest === undefined
      ? {}
      : { onInferenceRequest: options.onInferenceRequest }),
    modelId: resolved.modelId,
    surface,
    ...(oxyUserId === undefined ? {} : { oxyUserId }),
    ...(serviceToken === undefined ? {} : { serviceToken }),
    ...(options.reasoningEffort == null ? {} : { reasoningEffort: options.reasoningEffort }),
  });
}
