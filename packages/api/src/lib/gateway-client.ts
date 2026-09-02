/**
 * Product catalogue and billing facade.
 *
 * Hosted inference does not cross this module: Kaana is invoked through the
 * inference seam, and unsupported modalities fail before a provider adapter is
 * imported. The dynamic imports below retain only Alia-owned product metadata,
 * billing repositories and historical health views needed by non-inference
 * routes while their data migration is completed.
 */

import type { PlanFilter } from '../db/billing/planRepository.js';
import { assertUnreservedModelIdentifier } from './reserved-namespace.js';
import type { AvailabilityScope } from './availability-scope.js';
import type { RequiredAttribution } from './model-attribution.js';
import type { FallbackPolicy } from './routing/policy.js';
import { UnregisteredModelError } from './routing/policy.js';
import { formatModelIdentity, type ModelIdentity } from './routing/model-identity.js';
import { kaanaCapabilityUnavailable } from './inference/hosted-capability-error.js';

// ============== TYPES ==============

export interface KeyConfig {
  provider: string;
  modelId: string;
  /**
   * Whose machine answers, when `provider` is `user-runtime`.
   *
   * Present for exactly one kind of route and absent for every other: a model
   * served by its owner's own hardware has no credential to carry, so this is
   * what stands in for `key` — the binding that says which person's device, and
   * which of their devices, the request is handed to. See
   * `lib/inference/user-runtime-bridge.ts`.
   */
  userRuntime?: { userId: string; runtimeId: string };
}

export interface RoutingProfile {
  id: string;
  name: string;
  tier: string;
  description: string;
  creditMultiplier: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  category: string;
  emoji?: string;
}

export interface ModelMapping {
  provider: string;
  /**
   * Who RELEASED this model, which is never who serves it.
   *
   * Optional for the same reason `availabilityScope` is: this module is the
   * seam a Kaana catalogue arrives through, and Kaana does not carry the field
   * yet. The LOCAL branch reads `TIER_MODEL_MAPPINGS`, where every one of the
   * 115 mappings has it (`internal/providers/lib/model-publishers.ts`).
   *
   * Absent is UNKNOWN, never a guess. `lib/catalogue.ts` counts the routes that
   * arrived without one and publishes the count, so a provenance list built
   * from half a table cannot be mistaken for a complete one.
   */
  publisher?: string;
  /**
   * The publisher's own name for the model — the second half of ADR 0003's
   * `<publisher>/<model>` identity, and never what an operator calls its
   * deployment.
   *
   * Optional for the same reason `publisher` is, and absent for the same
   * reason: Kaana does not carry it yet. The LOCAL branch reads
   * `TIER_MODEL_MAPPINGS`, where every mapping carries it because it is
   * authored beside each route — 29 of the 58 deployment ids differ from their
   * model's name, so it cannot be recovered from `modelId`.
   */
  model?: string;
  modelId: string;
  priority: number;
  qualityScore: number;
  pricingTier: string;
  costPer1MInput?: number;
  costPer1MOutput?: number;
  costPerMinute?: number;
  averageLatencyMs?: number;
  capabilities: Record<string, unknown>;
  /**
   * Who this route may be served to (#139 workstream 17).
   *
   * Optional and populated by NOTHING in this repository: an availability scope
   * is a property of a deployment in the Oxy catalogue, and the local branch of
   * this facade reads `TIER_MODEL_MAPPINGS`, which has no such column. It is
   * declared here because this module is the seam a Kaana catalogue arrives
   * through, so the field lands where the data will, and `lib/catalogue.ts`
   * consumes it today against fixtures.
   *
   * Absent is UNCLASSIFIED, never "public": `lib/availability-scope.ts` keeps
   * those apart and `GET /catalogue` publishes how many routes were classified,
   * so a filter with nothing to filter cannot be mistaken for one that works.
   */
  availabilityScope?: AvailabilityScope;
  /** What this route's licence requires be displayed. Same seam, same absence. */
  attribution?: RequiredAttribution;
}

export interface ResolvedModel {
  routingProfileId: string;
  provider: string;
  /**
   * Who RELEASED the model, and their own name for it — the pair Kaana names
   * every deployment by.
   *
   * Optional because a routing profile does not identify the concrete model
   * Kaana will eventually choose. A pinned model carries both fields.
   */
  publisher?: string;
  model?: string;
  modelId: string;
  keyConfig: KeyConfig;
  routingProfile: RoutingProfile;
  isFallback: boolean;
}

/**
 * Per-request routing options.
 *
 * Declared here rather than re-exported from `internal/providers`, matching how
 * every other type on this page is declared: this module is the seam, and it
 * must not pull the provider tree in at module load. The shape is structurally
 * identical to `FallbackOptions` and is checked against it by `tsc` at the one
 * call site below that passes it across.
 */
export interface RoutingOptions {
  fallbackPolicy?: FallbackPolicy;
  /**
   * The model identity the caller named, when it named a model rather than a
   * profile (`lib/routing/model-selection.ts`).
   *
   * It travels beside the alias rather than replacing it because the two answer
   * different questions: the alias says which tier, price, plan and prompt
   * apply, and this says which of that tier's models may answer. Folding them
   * into one string would mean every consumer of the alias learning a second
   * vocabulary — the translation this seam exists to do once.
   */
  pinnedModel?: ModelIdentity;
}

export interface RoutingProfileWithAvailability extends RoutingProfile {
  isAvailable: boolean;
  isLegacy: boolean;
}

// No `RoutingTier` here. It was `= string`, imported by nothing and constraining
// nothing, while being the fourth declaration of a list whose whole problem was
// having four. `internal/providers/lib/routing-tiers.ts` owns it.
export type ModelCategory = string;
export type PricingTier = string;

// Plain (non-Document) interfaces for billing data returned by API or .lean()
export interface PlanData {
  planId: string;
  name: string;
  product: 'alia' | 'codea';
  creditsPerMonth: number;
  dailyFreeCredits: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  sortOrder: number;
  modelIds: string[];
  isActive: boolean;
  isFree: boolean;
  stripeProductId?: string;
  stripeMonthlyPriceId?: string;
  stripeAnnualPriceId?: string;
  description?: string;
}

export interface CreditPackageData {
  packageId: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  stripePriceId?: string;
  sortOrder: number;
  isActive: boolean;
  description?: string;
}

export interface FeatureData {
  featureId: string;
  label: string;
  description?: string;
  icon?: string;
  category: string;
  featureType: 'boolean' | 'limit';
  sortOrder: number;
  isVisibleOnPricing: boolean;
  isActive: boolean;
}

export interface PlanFeatureData {
  planId: string;
  featureId: string;
  enabled: boolean;
  limitValue?: number;
  displayLabel?: string;
  displayDescription?: string;
}

// ============== MODEL RESOLUTION ==============

/**
 * Resolve an Alia product profile to a credential-free Kaana target.
 *
 * `options.fallbackPolicy` is a property of the REQUEST (ADR 0003 invariant 3),
 * so it crosses this seam with the request rather than being read from process
 * config on the far side. Kaana, not this function, owns route attempts.
 */
export async function resolveRoutingProfile(
  model: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds?: Set<string>,
  options: RoutingOptions = {}
): Promise<ResolvedModel | null> {
  // ADR 0002: the `alia/*` publisher namespace is reserved and empty. Refused
  // here before any target is handed to Kaana.
  assertUnreservedModelIdentifier(model);

  void tokens;
  void skipProviders;
  void skipKeyIds;
  const routingProfile = await getRoutingProfile(model);
  if (routingProfile === null) {
    throw new UnregisteredModelError(model, (await getAllRoutingProfiles()).map((entry) => entry.id));
  }
  const target = options.pinnedModel === undefined ? model : formatModelIdentity(options.pinnedModel);
  return {
    routingProfileId: model,
    provider: 'kaana',
    publisher: 'kaana',
    model: target,
    modelId: target,
    keyConfig: { provider: 'kaana', modelId: target },
    routingProfile,
    isFallback: false,
  };
}

// ============== RETIRED PROVIDER COMPATIBILITY SHAPES ==============

/** DO async-invoke models (fal-ai) need longer timeouts for queue + cold start + execution */
export function getProviderTimeout(modelId: string): number {
  return modelId.startsWith('fal-ai/') ? 120_000 : 15_000;
}

export interface ProviderCallOptions {
  provider: string;
  modelId: string;
  endpoint: string;
  body?: Record<string, unknown>;
  audio?: { base64: string; mimeType: string; filename: string };
  extraFormFields?: Record<string, string>;
  maxAttempts?: number;
  timeout?: number;
  responseType?: 'json' | 'arrayBuffer';
  signal?: AbortSignal;
}

/**
 * Compatibility seam for callers not yet migrated to a Kaana modality.
 * It never resolves a provider, credential or URL; every call fails closed with
 * the capability-specific Kaana error.
 */
export async function callProviderAPI<T = unknown>(options: ProviderCallOptions): Promise<T> {
  const capability = options.endpoint.includes('transcriptions')
    ? 'speech_transcription'
    : options.endpoint.includes('speech')
      ? 'speech_synthesis'
      : options.endpoint.includes('image')
        ? 'image_generation'
        : options.endpoint.includes('embedding')
          ? 'embedding'
          : 'audio_generation';
  throw kaanaCapabilityUnavailable(capability);
}

// ============== MODEL DATA ==============

/**
 * Get all alia models.
 */
export async function getAllRoutingProfiles(): Promise<RoutingProfile[]> {
  const { getAllRoutingProfiles: localGetAll } = await import('../internal/providers/lib/routing-profile-catalogue.js');
  return localGetAll();
}

/**
 * Get all product profiles without consulting Alia provider health.
 *
 * Kaana owns live availability. The legacy bit remains Alia product metadata
 * and is read from the retained catalogue table until its migration completes.
 */
export async function getAvailableModels(): Promise<RoutingProfileWithAvailability[]> {
  const models = await getAllRoutingProfiles();
  const legacy = new Map<string, boolean>();
  const { getDb } = await import('../db/index.js');
  const { listRoutingProfiles } = await import('../db/providers/routingProfileRepository.js');
  for (const row of await listRoutingProfiles(getDb())) legacy.set(row.routingProfileId, row.isLegacy);
  return models.map((model) => ({
    ...model,
    isAvailable: true,
    isLegacy: legacy.get(model.id) ?? false,
  }));
}

/**
 * Get a specific alia model by ID.
 */
export async function getRoutingProfile(modelId: string): Promise<RoutingProfile | null> {
  const { getRoutingProfile: localGet } = await import('../internal/providers/lib/routing-profile-catalogue.js');
  return localGet(modelId);
}

/**
 * Check if a model ID is an alia model.
 */
export async function isRoutingProfile(modelId: string): Promise<boolean> {
  const { isRoutingProfile: localIsAlia } = await import('../internal/providers/lib/routing-profile-catalogue.js');
  return localIsAlia(modelId);
}

/**
 * Get all alia models by category.
 */
export async function getRoutingProfilesByCategory(category: string): Promise<RoutingProfile[]> {
  const { getRoutingProfilesByCategory: localGetByCategory } = await import('../internal/providers/lib/routing-profile-catalogue.js');
  return localGetByCategory(category as never);
}

/**
 * Get default model for a category.
 */
export async function getDefaultModelForCategory(category: string): Promise<RoutingProfile | null> {
  const { getDefaultModelForCategory: localGetDefault } = await import('../internal/providers/lib/routing-profile-catalogue.js');
  return localGetDefault(category as never);
}

/**
 * THE default chat model: what a request that named none runs on.
 *
 * This is the single owner used by chat, agents, webhooks and canvas execution.
 *
 * Which profile a caller gets by default is Alia's product decision, not
 * something an inference provider may answer differently.
 *
 * It agrees with `getDefaultModelForCategory('general')`, which is what
 * `GET /v1/models?category=general` advertises as `default_model` — the two are
 * derived independently (this is a constant, that one minimises
 * `creditMultiplier`), so `defaultChatModel.test.ts` asserts they still match
 * rather than assuming it.
 *
 * Anything needing the default IMPORTS it. Restating the literal is what
 * produced the divergence this replaced; the frozen census in that test names
 * every site still holding its own.
 */
export function getDefaultRoutingProfile(): string {
  return 'kaana-lite';
}

// ============== TIER MAPPINGS ==============

/**
 * Get tier-to-model mappings.
 */
export async function getTierMappings(): Promise<Record<string, ModelMapping[]>> {
  const { TIER_MODEL_MAPPINGS } = await import('../internal/providers/lib/routing-profile-catalogue.js');
  return TIER_MODEL_MAPPINGS as unknown as Record<string, ModelMapping[]>;
}

/**
 * Get model mappings for a specific tier.
 */
export async function getModelMappingsForTier(tier: string): Promise<ModelMapping[]> {
  const { getModelMappingsForTier: localGetMappings } = await import('../internal/providers/lib/routing-profile-catalogue.js');
  return localGetMappings(tier as never) as unknown as ModelMapping[];
}

// ============== BILLING DATA ==============

/**
 * Get plans.
 */
export async function getPlans(filter?: PlanFilter): Promise<PlanData[]> {
  const { getDb } = await import('../db/index.js');
  const { selectPlans } = await import('../db/billing/planRepository.js');
  return selectPlans(getDb(), filter ?? {}) as unknown as Promise<PlanData[]>;
}

/**
 * Get credit packages.
 */
export async function getCreditPackages(active?: boolean): Promise<CreditPackageData[]> {
  const { getDb } = await import('../db/index.js');
  const { selectCreditPackages } = await import('../db/billing/creditPackageRepository.js');
  return selectCreditPackages(getDb(), active === undefined ? {} : { isActive: active }) as unknown as CreditPackageData[];
}

/**
 * Get features.
 */
export async function getFeatures(): Promise<FeatureData[]> {
  const { getDb } = await import('../db/index.js');
  const { selectAllFeatures } = await import('../db/billing/featureRepository.js');
  return selectAllFeatures(getDb()) as unknown as FeatureData[];
}

/**
 * Get plan features.
 */
export async function getPlanFeatures(planId?: string): Promise<PlanFeatureData[]> {
  const { getDb } = await import('../db/index.js');
  const { selectPlanFeatures } = await import('../db/billing/planFeatureRepository.js');
  return selectPlanFeatures(getDb(), planId ? { planId } : {}) as unknown as PlanFeatureData[];
}

/**
 * Update a plan (e.g. to persist auto-created Stripe price IDs).
 */
export async function updatePlan(
  planId: string,
  updates: { stripeProductId?: string; stripeMonthlyPriceId?: string; stripeAnnualPriceId?: string },
): Promise<PlanData | null> {
  const { getDb } = await import('../db/index.js');
  const { updatePlanByPlanId } = await import('../db/billing/planRepository.js');
  return updatePlanByPlanId(getDb(), planId, updates) as unknown as Promise<PlanData | null>;
}
