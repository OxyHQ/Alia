/**
 * Gateway Client — Dual-mode facade
 *
 * When the gateway API is configured (BOTH SERVICE_SECRET and GATEWAY_API_URL set):
 *   → Routes all calls through the alia-gateway HTTP service
 *
 * When the gateway API is NOT configured (either variable missing):
 *   → Falls back to direct imports from internal/providers/ modules
 *
 * Gateway mode requires EXPLICIT config: without a deployed alia-gateway and a
 * GATEWAY_API_URL pointing at it, the facade uses its in-process local fallback
 * (the Postgres repositories + internal/providers/*). This mirrors the ecosystem
 * env-gating convention (e.g. REDIS_URL → BullMQ, else inline).
 *
 * Consumer files always import from this module — the backend is transparent.
 *
 * The local fallbacks below load their repositories through `await import()`,
 * which is the shape the pre-existing code used for the Mongoose models and is
 * kept: this module is imported at boot by callers that must not pull the whole
 * `internal/providers` tree in with it.
 */

import crypto from 'crypto';
import type { PlanFilter } from '../db/billing/planRepository.js';
import { log } from './logger.js';
import { getStatusCode } from './errors/index.js';
import { assertUnreservedModelIdentifier } from './reserved-namespace.js';
import type { AvailabilityScope } from './availability-scope.js';
import type { RequiredAttribution } from './model-attribution.js';
import type { FallbackPolicy } from './routing/policy.js';
import type { ModelIdentity } from './routing/model-identity.js';

// ============== MODE DETECTION ==============

const SERVICE_SECRET = process.env.SERVICE_SECRET;
const GATEWAY_API_URL = process.env.GATEWAY_API_URL;
const GATEWAY_API_ENABLED = !!(SERVICE_SECRET && GATEWAY_API_URL);

if (!GATEWAY_API_ENABLED) {
  log.general.info(
    'Gateway API not configured (requires both SERVICE_SECRET and GATEWAY_API_URL) — using local fallback',
  );
}

// ============== HTTP AUTH (only used when GATEWAY_API_ENABLED) ==============

const SERVICE_NAME = 'alia-api';

/**
 * Resolve the gateway config, narrowing the env vars to concrete strings.
 * Only reachable from the GATEWAY_API_ENABLED branches; throws otherwise so a
 * misconfiguration surfaces loudly instead of hitting a bogus localhost URL.
 */
function requireGatewayConfig(): { url: string; secret: string } {
  if (!GATEWAY_API_URL || !SERVICE_SECRET) {
    throw new Error('Gateway API is not configured (requires SERVICE_SECRET and GATEWAY_API_URL)');
  }
  return { url: GATEWAY_API_URL, secret: SERVICE_SECRET };
}

/**
 * Build service-to-service auth headers. The HMAC binds the method, full path
 * (with query), and a hash of the serialized body — not just timestamp/service —
 * so a captured signature can't be replayed against a different endpoint. This
 * MUST match `buildServiceSigningString` in alia-gateway's auth middleware.
 */
function generateAuthHeaders(method: string, path: string, body: string = ''): Record<string, string> {
  const { secret } = requireGatewayConfig();
  const timestamp = Date.now().toString();
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const payload = [timestamp, SERVICE_NAME, method.toUpperCase(), path, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  return {
    'X-Service-Name': SERVICE_NAME,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json',
  };
}

async function apiGet<T = unknown>(path: string): Promise<T> {
  const { url } = requireGatewayConfig();
  const res = await fetch(`${url}${path}`, {
    headers: generateAuthHeaders('GET', path),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gateway API GET ${path} failed (${res.status}): ${body}`);
  }
  const json = await res.json() as Record<string, unknown>;
  return (json.data ?? json) as T;
}

async function apiPost<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const { url } = requireGatewayConfig();
  const serializedBody = JSON.stringify(body);
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: generateAuthHeaders('POST', path, serializedBody),
    body: serializedBody,
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: { error?: string; reason?: string };
    try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
    const error = new Error(parsed.error || `Gateway API POST ${path} failed (${res.status})`) as Error & { reason?: string; status?: number };
    error.reason = parsed.reason;
    error.status = res.status;
    throw error;
  }
  const json = await res.json() as Record<string, unknown>;
  return (json.data ?? json) as T;
}

async function apiPatch<T = unknown>(path: string, body: unknown): Promise<T> {
  const { url } = requireGatewayConfig();
  const serializedBody = JSON.stringify(body);
  const res = await fetch(`${url}${path}`, {
    method: 'PATCH',
    headers: generateAuthHeaders('PATCH', path, serializedBody),
    body: serializedBody,
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: { error?: string };
    try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
    const error = new Error(parsed.error || `Gateway API PATCH ${path} failed (${res.status})`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  const json = await res.json() as Record<string, unknown>;
  return (json.data ?? json) as T;
}

// ============== TYPES ==============

export interface KeyConfig {
  keyId?: string;
  provider: string;
  modelId: string;
  key: string;
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
  isPaid?: boolean;
  rps?: number;
  rpm?: number;
  rph?: number;
  rpd?: number;
  tps?: number;
  tpm?: number;
  tph?: number;
  tpd?: number;
}

export interface AliaModel {
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
  aliasModelId: string;
  provider: string;
  /**
   * Who RELEASED the model, and their own name for it — the pair Kaana names
   * every deployment by.
   *
   * Optional because this seam has two paths and only one of them carries it:
   * the local resolver copies both from the mapping (`fallback-engine.ts`),
   * while a remote gateway returns whatever it returns. Declaring them required
   * would be a claim about a service this repository does not contain — the
   * shape was previously asserted with a cast, which is how the absence would
   * have surfaced as `undefined/undefined` reaching Kaana rather than as a type
   * error here.
   */
  publisher?: string;
  model?: string;
  modelId: string;
  keyConfig: KeyConfig;
  aliaModel: AliaModel;
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

export interface HealthMetrics {
  provider: string;
  modelId: string;
  successCount: number;
  failureCount: number;
  totalRequests: number;
  successRate: number;
  averageLatencyMs: number;
  lastSuccess: Date | null;
  lastFailure: Date | null;
  consecutiveFailures: number;
  circuitState: string;
  lastHealthCheck: Date;
  isHealthy: boolean;
}

export interface AliaModelWithAvailability extends AliaModel {
  isAvailable: boolean;
  isLegacy: boolean;
}

// No `AliaTier` here. It was `= string`, imported by nothing and constraining
// nothing, while being the fourth declaration of a list whose whole problem was
// having four. `internal/providers/lib/alia-tiers.ts` owns it.
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

// ============== IN-MEMORY CACHE (HTTP mode only) ==============

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL = 60_000; // 60 seconds
let modelsCache: CacheEntry<AliaModel[]> | null = null;
let tierMappingsCache: CacheEntry<Record<string, ModelMapping[]>> | null = null;

function isCacheValid<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return entry !== null && Date.now() < entry.expiresAt;
}

// ============== MODEL RESOLUTION ==============

/**
 * Resolve an alia model to a concrete provider + key.
 * Used before streaming chat completions.
 *
 * `options.fallbackPolicy` is a property of the REQUEST (ADR 0003 invariant 3),
 * so it crosses this seam with the request rather than being read from process
 * config on the far side. Omitting it is what every existing caller does and
 * selects `DEFAULT_FALLBACK_POLICY`, which is the behaviour this function has
 * always had.
 */
export async function resolveAliaModel(
  model: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds?: Set<string>,
  options: RoutingOptions = {}
): Promise<ResolvedModel | null> {
  // ADR 0002: the `alia/*` publisher namespace is reserved and empty. Refused
  // here, above the mode branch, so both the remote gateway path and the local
  // path are covered by one statement. This is the serving chokepoint: outside
  // `internal/providers/` nothing else reaches `model-resolver`, which the
  // architecture gates' frozen importer list is what proves.
  assertUnreservedModelIdentifier(model);

  if (GATEWAY_API_ENABLED) {
    try {
      return await apiPost<ResolvedModel>('/api/resolve', {
        model,
        estimatedTokens: tokens,
        skipProviders: [...skipProviders],
        skipKeyIds: skipKeyIds ? [...skipKeyIds] : [],
        fallbackPolicy: options.fallbackPolicy,
        // Named `pinnedModel` and not `model`, which this payload already uses
        // for the alias. Two different things under one key is how a routing
        // decision gets read as the other one.
        pinnedModel: options.pinnedModel,
      });
    } catch (error: unknown) {
      if (getStatusCode(error) === 503) return null;
      throw error;
    }
  }

  // Local fallback
  const { resolveAliaModel: localResolve } = await import('../internal/providers/lib/model-resolver.js');
  return localResolve(model, tokens, skipProviders, skipKeyIds || new Set(), options);
}

// ============== PROVIDER HELPERS ==============

/** DO async-invoke models (fal-ai) need longer timeouts for queue + cold start + execution */
export function getProviderTimeout(modelId: string): number {
  return modelId.startsWith('fal-ai/') ? 120_000 : 15_000;
}

// ============== PROVIDER API CALLS ==============

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
 * Non-streaming provider API call with key rotation and retries.
 * Used for images, embeddings, transcription.
 */
export async function callProviderAPI<T = unknown>(options: ProviderCallOptions): Promise<T> {
  if (GATEWAY_API_ENABLED) {
    const { signal, ...bodyOptions } = options;
    const result = await apiPost<T>('/api/call', bodyOptions, signal);

    // Gateway returns base64-encoded binary for arrayBuffer responses — decode it
    if (options.responseType === 'arrayBuffer' && typeof result === 'string') {
      return Buffer.from(result, 'base64') as unknown as T;
    }

    return result;
  }

  // Local fallback — convert audio field to FormData for the local callProviderAPI
  const { callProviderAPI: localCall } = await import('../internal/providers/lib/provider-api.js');

  let formData: FormData | undefined;
  if (options.audio?.base64) {
    const buffer = Buffer.from(options.audio.base64, 'base64');
    const blob = new Blob([buffer], { type: options.audio.mimeType || 'audio/webm' });
    formData = new FormData();
    formData.append('file', blob, options.audio.filename || 'audio.webm');
    if (options.extraFormFields) {
      for (const [key, value] of Object.entries(options.extraFormFields)) {
        formData.append(key, value);
      }
    }
  }

  return localCall<T>({
    provider: options.provider,
    modelId: options.modelId,
    endpoint: options.endpoint,
    body: options.body,
    formData,
    maxAttempts: options.maxAttempts,
    timeout: options.timeout,
    responseType: options.responseType,
    signal: options.signal,
  });
}

// ============== USAGE REPORTING ==============

/**
 * Report model usage after streaming (fire-and-forget).
 */
export function reportModelUsage(
  keyId: string,
  provider: string,
  modelId: string,
  success: boolean,
  opts?: { latencyMs?: number; errorCode?: string; tokens?: number; reason?: string; retryAfterMs?: number }
): void {
  if (GATEWAY_API_ENABLED) {
    apiPost('/api/report', {
      keyId,
      provider,
      modelId,
      success,
      ...opts,
    }).catch((err: unknown) => {
      log.general.warn({ err }, 'Failed to report model usage');
    });
    return;
  }

  // Local fallback — fire-and-forget
  void (async () => {
    try {
      const { recordKeySuccess, recordKeyFailure } = await import('../internal/providers/lib/key-manager.js');
      const { recordSuccess, recordFailure } = await import('../internal/providers/lib/provider-health.js');

      if (success) {
        await recordKeySuccess(keyId);
        await recordSuccess(provider, modelId, opts?.latencyMs ?? 0);
      } else {
        await recordKeyFailure(keyId, opts?.errorCode || 'unknown', opts?.retryAfterMs);
        await recordFailure(provider, modelId, opts?.errorCode || 'unknown');
      }
    } catch (err) {
      log.general.warn({ err }, 'Failed to report model usage (local)');
    }
  })();
}

// ============== MODEL DATA ==============

/**
 * Get all alia models.
 */
export async function getAllAliaModels(): Promise<AliaModel[]> {
  if (GATEWAY_API_ENABLED) {
    if (isCacheValid(modelsCache)) return modelsCache.data;
    const data = await apiGet<{ models: AliaModel[] }>('/api/models');
    const models = data.models;
    modelsCache = { data: models, expiresAt: Date.now() + CACHE_TTL };
    return models;
  }

  const { getAllAliaModels: localGetAll } = await import('../internal/providers/lib/alia-models.js');
  return localGetAll();
}

/**
 * Get all alia models with availability (checks health).
 */
export async function getAvailableModels(): Promise<AliaModelWithAvailability[]> {
  if (GATEWAY_API_ENABLED) {
    const data = await apiGet<{ models: AliaModelWithAvailability[] }>('/api/models?available=true');
    return data.models;
  }

  const { getAvailableModels: localGetAvailable } = await import('../internal/providers/lib/alia-models.js');
  return localGetAvailable();
}

/**
 * Get a specific alia model by ID.
 */
export async function getAliaModel(modelId: string): Promise<AliaModel | null> {
  if (GATEWAY_API_ENABLED) {
    const models = await getAllAliaModels();
    return models.find(m => m.id === modelId) ?? null;
  }

  const { getAliaModel: localGet } = await import('../internal/providers/lib/alia-models.js');
  return localGet(modelId);
}

/**
 * Synchronous model lookup from cache (returns null if cache cold).
 */
export function getAliaModelSync(modelId: string): AliaModel | null {
  if (GATEWAY_API_ENABLED) {
    if (!isCacheValid(modelsCache)) return null;
    return modelsCache.data.find(m => m.id === modelId) ?? null;
  }

  // Local: always available from static ALIA_MODELS
  // Use synchronous require-like approach via dynamic import cache
  // Since this is sync, we can't use await — fall back to null if not cached
  try {
    // The module is likely already loaded from a prior async call
    const mod = (globalThis as unknown as Record<string, { getAliaModel: (id: string) => AliaModel | null }>).__aliaModelsCache;
    if (mod) return mod.getAliaModel(modelId);
  } catch { /* ignore */ }
  return null;
}

/**
 * Check if a model ID is an alia model.
 */
export async function isAliaModel(modelId: string): Promise<boolean> {
  if (GATEWAY_API_ENABLED) {
    const models = await getAllAliaModels();
    return models.some(m => m.id === modelId);
  }

  const { isAliaModel: localIsAlia } = await import('../internal/providers/lib/alia-models.js');
  return localIsAlia(modelId);
}

/**
 * Get all alia models by category.
 */
export async function getAliaModelsByCategory(category: string): Promise<AliaModel[]> {
  if (GATEWAY_API_ENABLED) {
    const models = await getAllAliaModels();
    return models.filter(m => m.category === category);
  }

  const { getAliaModelsByCategory: localGetByCategory } = await import('../internal/providers/lib/alia-models.js');
  return localGetByCategory(category as never);
}

/**
 * Get default model for a category.
 */
export async function getDefaultModelForCategory(category: string): Promise<AliaModel | null> {
  if (GATEWAY_API_ENABLED) {
    const models = await getAliaModelsByCategory(category);
    if (models.length === 0) return null;
    return models.reduce((best, m) => m.creditMultiplier < best.creditMultiplier ? m : best);
  }

  const { getDefaultModelForCategory: localGetDefault } = await import('../internal/providers/lib/alia-models.js');
  return localGetDefault(category as never);
}

/**
 * THE default chat model: what a request that named none runs on.
 *
 * This is the single owner. `internal/providers/lib/model-resolver.ts` declared
 * a second one returning `alia-v1`; it had no importers, so every live path —
 * `/v1/chat/completions` via `lib/chat/request-context.ts`,
 * the agent runner, the Telegram webhook, canvas node execution — has always
 * reached this one through `chat-core.js`. The other is deleted rather than
 * reconciled, because a value nobody reads cannot be the right answer.
 *
 * Unlike its neighbours this does not branch on `GATEWAY_API_ENABLED`, and that
 * is correct: which alias a caller gets by default is Alia's product decision,
 * not something a routing tier may answer differently.
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
export function getDefaultAliaModel(): string {
  return 'alia-lite';
}

// ============== TIER MAPPINGS ==============

/**
 * Get tier-to-model mappings.
 */
export async function getTierMappings(): Promise<Record<string, ModelMapping[]>> {
  if (GATEWAY_API_ENABLED) {
    if (isCacheValid(tierMappingsCache)) return tierMappingsCache.data;
    const data = await apiGet<{ models: AliaModel[]; tierMappings: Record<string, ModelMapping[]> }>(
      '/api/models?tierMappings=true'
    );
    const mappings = data.tierMappings;
    tierMappingsCache = { data: mappings, expiresAt: Date.now() + CACHE_TTL };
    if (data.models) {
      modelsCache = { data: data.models, expiresAt: Date.now() + CACHE_TTL };
    }
    return mappings;
  }

  const { TIER_MODEL_MAPPINGS } = await import('../internal/providers/lib/alia-models.js');
  return TIER_MODEL_MAPPINGS as unknown as Record<string, ModelMapping[]>;
}

/**
 * Get model mappings for a specific tier.
 */
export async function getModelMappingsForTier(tier: string): Promise<ModelMapping[]> {
  if (GATEWAY_API_ENABLED) {
    const mappings = await getTierMappings();
    // `Object.hasOwn`, not `??`: `tier` derives from a caller-supplied model
    // identifier, and `mappings` is a plain object, so `mappings['constructor']`
    // is a function that `??` happily passes through as a mapping list.
    return Object.hasOwn(mappings, tier) ? mappings[tier] : [];
  }

  const { getModelMappingsForTier: localGetMappings } = await import('../internal/providers/lib/alia-models.js');
  return localGetMappings(tier as never) as unknown as ModelMapping[];
}

// ============== PROVIDER HEALTH ==============

/**
 * Get all provider health metrics.
 */
export async function getAllProviderHealth(): Promise<HealthMetrics[]> {
  if (GATEWAY_API_ENABLED) {
    return apiGet<HealthMetrics[]>('/api/health');
  }

  const { getAllProviderHealth: localGetAll } = await import('../internal/providers/lib/provider-health.js');
  return localGetAll();
}

/**
 * Get health for a specific provider/model.
 */
export async function getProviderHealth(provider: string, modelId: string): Promise<HealthMetrics> {
  if (GATEWAY_API_ENABLED) {
    return apiGet<HealthMetrics>(`/api/health?provider=${encodeURIComponent(provider)}&modelId=${encodeURIComponent(modelId)}`);
  }

  const { getProviderHealth: localGet } = await import('../internal/providers/lib/provider-health.js');
  return localGet(provider, modelId);
}

// ============== BILLING DATA ==============

/**
 * Get plans.
 */
export async function getPlans(filter?: PlanFilter): Promise<PlanData[]> {
  if (GATEWAY_API_ENABLED) {
    const data = await apiGet<{ plans: PlanData[] }>('/api/billing?type=plans');
    const plans = data.plans ?? [];
    if (!filter) return plans;
    return plans.filter(p => Object.entries(filter).every(([k, v]) => (p as unknown as Record<string, unknown>)[k] === v));
  }

  const { getDb } = await import('../db/index.js');
  const { selectPlans } = await import('../db/billing/planRepository.js');
  return selectPlans(getDb(), filter ?? {}) as unknown as Promise<PlanData[]>;
}

/**
 * Get credit packages.
 */
export async function getCreditPackages(active?: boolean): Promise<CreditPackageData[]> {
  if (GATEWAY_API_ENABLED) {
    const query = active !== undefined ? `&active=${active}` : '';
    const data = await apiGet<{ packages: CreditPackageData[] }>(`/api/billing?type=packages${query}`);
    return data.packages ?? [];
  }

  const { getDb } = await import('../db/index.js');
  const { selectCreditPackages } = await import('../db/billing/creditPackageRepository.js');
  return selectCreditPackages(getDb(), active === undefined ? {} : { isActive: active }) as unknown as CreditPackageData[];
}

/**
 * Get features.
 */
export async function getFeatures(): Promise<FeatureData[]> {
  if (GATEWAY_API_ENABLED) {
    const data = await apiGet<{ features: FeatureData[] }>('/api/billing?type=features');
    return data.features ?? [];
  }

  const { getDb } = await import('../db/index.js');
  const { selectAllFeatures } = await import('../db/billing/featureRepository.js');
  return selectAllFeatures(getDb()) as unknown as FeatureData[];
}

/**
 * Get plan features.
 */
export async function getPlanFeatures(planId?: string): Promise<PlanFeatureData[]> {
  if (GATEWAY_API_ENABLED) {
    const query = planId ? `&planId=${encodeURIComponent(planId)}` : '';
    const data = await apiGet<{ planFeatures: PlanFeatureData[] }>(`/api/billing?type=plan-features${query}`);
    return data.planFeatures ?? [];
  }

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
  if (GATEWAY_API_ENABLED) {
    return apiPatch(`/v1/plans/${planId}`, updates);
  }

  const { getDb } = await import('../db/index.js');
  const { updatePlanByPlanId } = await import('../db/billing/planRepository.js');
  return updatePlanByPlanId(getDb(), planId, updates) as unknown as Promise<PlanData | null>;
}

// ============== KEY MANAGEMENT ==============

/**
 * Mark a provider key as credit-exhausted.
 * Routes through gateway API when enabled so it operates on the correct database.
 */
export async function markKeyCreditExhausted(keyId: string): Promise<void> {
  if (!keyId) return;
  if (GATEWAY_API_ENABLED) {
    apiPost('/api/report', { keyId, provider: '', modelId: '', success: false, reason: 'billing' }).catch(() => {});
    return;
  }
  const { markKeyCreditExhausted: localMark } = await import('../internal/providers/lib/key-manager.js');
  localMark(keyId).catch(() => {});
}

/**
 * The providers this deployment holds a usable credential for, by name.
 *
 * ## It has no `GATEWAY_API_ENABLED` branch, and that is the correct shape
 *
 * Every other function in this file has two, because it reads data the gateway
 * would own. This one does not, because the thing it describes is not dual-mode:
 * `getBestKeyForModel` is imported STRAIGHT from `key-manager` by
 * `internal/providers/lib/provider-api.ts` and `fallback-engine.ts`, never
 * through this facade, so the local `provider_keys` table is what a completion
 * draws its credential from whether or not a gateway is configured. Answering
 * from anywhere else would describe a table no request reads.
 *
 * A branch here would therefore be a plausible-looking lie of exactly the kind
 * this change exists to remove, so there is deliberately nowhere for one to go.
 */
export async function providersWithUsableCredentials(): Promise<Set<string>> {
  const { providersWithUsableCredentials: localProviders } = await import(
    '../internal/providers/lib/key-manager.js'
  );
  return localProviders();
}

// ============== CACHE WARMUP ==============

/**
 * Warm up the in-memory cache at startup.
 */
export async function warmupGatewayClient(): Promise<void> {
  if (!GATEWAY_API_ENABLED) {
    log.general.info('Gateway client using local modules — no warmup needed');
    return;
  }

  try {
    await getTierMappings();
    log.general.info('Gateway client cache warmed up');
  } catch (error: unknown) {
    log.general.warn({ err: error }, 'Failed to warm up gateway client cache (gateway API may not be ready)');
  }
}
