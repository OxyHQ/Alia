/**
 * Providers Client — Dual-mode facade
 *
 * When PROVIDERS_API is available (SERVICE_SECRET is set):
 *   → Routes all calls through the alia-providers-api HTTP service
 *
 * When PROVIDERS_API is NOT available:
 *   → Falls back to direct imports from internal/providers/ modules
 *
 * Consumer files always import from this module — the backend is transparent.
 */

import crypto from 'crypto';
import { log } from './logger.js';

// ============== MODE DETECTION ==============

const SERVICE_SECRET = process.env.SERVICE_SECRET;
const PROVIDERS_API_URL = process.env.PROVIDERS_API_URL || 'http://localhost:9091';
const PROVIDERS_API_ENABLED = !!SERVICE_SECRET;

if (!PROVIDERS_API_ENABLED) {
  log.general.info('Providers API not configured (no SERVICE_SECRET) — using local fallback');
}

// ============== HTTP AUTH (only used when PROVIDERS_API_ENABLED) ==============

const SERVICE_NAME = 'alia-api';

function generateAuthHeaders(): Record<string, string> {
  const timestamp = Date.now().toString();
  const payload = JSON.stringify({ timestamp, service: SERVICE_NAME });
  const signature = crypto.createHmac('sha256', SERVICE_SECRET!).update(payload).digest('hex');

  return {
    'X-Service-Name': SERVICE_NAME,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json',
  };
}

async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(`${PROVIDERS_API_URL}${path}`, {
    headers: generateAuthHeaders(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Providers API GET ${path} failed (${res.status}): ${body}`);
  }
  const json = await res.json() as any;
  return json.data ?? json;
}

async function apiPost<T = any>(path: string, body: any): Promise<T> {
  const res = await fetch(`${PROVIDERS_API_URL}${path}`, {
    method: 'POST',
    headers: generateAuthHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
    const error: any = new Error(parsed.error || `Providers API POST ${path} failed (${res.status})`);
    error.reason = parsed.reason;
    error.status = res.status;
    throw error;
  }
  const json = await res.json() as any;
  return json.data ?? json;
}

async function apiPatch<T = any>(path: string, body: any): Promise<T> {
  const res = await fetch(`${PROVIDERS_API_URL}${path}`, {
    method: 'PATCH',
    headers: generateAuthHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
    const error: any = new Error(parsed.error || `Providers API PATCH ${path} failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  const json = await res.json() as any;
  return json.data ?? json;
}

// ============== TYPES ==============

export interface KeyConfig {
  keyId?: string;
  provider: string;
  modelId: string;
  key: string;
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
  chatVisible?: boolean;
}

export interface ModelMapping {
  provider: string;
  modelId: string;
  priority: number;
  qualityScore: number;
  pricingTier: string;
  costPer1MInput?: number;
  costPer1MOutput?: number;
  costPerMinute?: number;
  averageLatencyMs?: number;
  capabilities: any;
}

export interface ResolvedModel {
  aliasModelId: string;
  provider: string;
  modelId: string;
  keyConfig: KeyConfig;
  aliaModel: AliaModel;
  isFallback: boolean;
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

export type AliaTier = string;
export type ModelCategory = string;
export type PricingTier = string;

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
 */
export async function resolveAliaModel(
  model: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds?: Set<string>
): Promise<ResolvedModel | null> {
  if (PROVIDERS_API_ENABLED) {
    try {
      return await apiPost<ResolvedModel>('/api/resolve', {
        model,
        estimatedTokens: tokens,
        skipProviders: [...skipProviders],
        skipKeyIds: skipKeyIds ? [...skipKeyIds] : [],
      });
    } catch (error: any) {
      if (error.status === 503) return null;
      throw error;
    }
  }

  // Local fallback
  const { resolveAliaModel: localResolve } = await import('../internal/providers/lib/model-resolver.js');
  return localResolve(model, tokens, skipProviders, skipKeyIds || new Set());
}

// ============== PROVIDER API CALLS ==============

export interface ProviderCallOptions {
  provider: string;
  modelId: string;
  endpoint: string;
  body?: any;
  audio?: { base64: string; mimeType: string; filename: string };
  extraFormFields?: Record<string, string>;
  maxAttempts?: number;
  timeout?: number;
}

/**
 * Non-streaming provider API call with key rotation and retries.
 * Used for images, embeddings, transcription.
 */
export async function callProviderAPI<T = any>(options: ProviderCallOptions): Promise<T> {
  if (PROVIDERS_API_ENABLED) {
    return apiPost<T>('/api/call', options);
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
  opts?: { latencyMs?: number; errorCode?: string; tokens?: number; reason?: string }
): void {
  if (PROVIDERS_API_ENABLED) {
    apiPost('/api/report', {
      keyId,
      provider,
      modelId,
      success,
      ...opts,
    }).catch((err: any) => {
      log.general.warn({ err }, 'Failed to report model usage');
    });
    return;
  }

  // Local fallback — fire-and-forget
  (async () => {
    try {
      const { recordKeySuccess, recordKeyFailure } = await import('../internal/providers/lib/key-manager.js');
      const { recordSuccess, recordFailure } = await import('../internal/providers/lib/provider-health.js');

      if (success) {
        await recordKeySuccess(keyId);
        await recordSuccess(provider, modelId, opts?.latencyMs ?? 0);
      } else {
        await recordKeyFailure(keyId, opts?.errorCode || 'unknown');
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
  if (PROVIDERS_API_ENABLED) {
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
  if (PROVIDERS_API_ENABLED) {
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
  if (PROVIDERS_API_ENABLED) {
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
  if (PROVIDERS_API_ENABLED) {
    if (!isCacheValid(modelsCache)) return null;
    return modelsCache.data.find(m => m.id === modelId) ?? null;
  }

  // Local: always available from static ALIA_MODELS
  // Use synchronous require-like approach via dynamic import cache
  // Since this is sync, we can't use await — fall back to null if not cached
  try {
    // The module is likely already loaded from a prior async call
    const mod = (globalThis as any).__aliaModelsCache;
    if (mod) return mod.getAliaModel(modelId);
  } catch { /* ignore */ }
  return null;
}

/**
 * Check if a model ID is an alia model.
 */
export async function isAliaModel(modelId: string): Promise<boolean> {
  if (PROVIDERS_API_ENABLED) {
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
  if (PROVIDERS_API_ENABLED) {
    const models = await getAllAliaModels();
    return models.filter(m => m.category === category);
  }

  const { getAliaModelsByCategory: localGetByCategory } = await import('../internal/providers/lib/alia-models.js');
  return localGetByCategory(category as any);
}

/**
 * Get default model for a category.
 */
export async function getDefaultModelForCategory(category: string): Promise<AliaModel | null> {
  if (PROVIDERS_API_ENABLED) {
    const models = await getAliaModelsByCategory(category);
    if (models.length === 0) return null;
    return models.reduce((best, m) => m.creditMultiplier < best.creditMultiplier ? m : best);
  }

  const { getDefaultModelForCategory: localGetDefault } = await import('../internal/providers/lib/alia-models.js');
  return localGetDefault(category as any);
}

/**
 * Get the default alia model ID.
 */
export function getDefaultAliaModel(): string {
  return 'alia-lite';
}

// ============== TIER MAPPINGS ==============

/**
 * Get tier-to-model mappings.
 */
export async function getTierMappings(): Promise<Record<string, ModelMapping[]>> {
  if (PROVIDERS_API_ENABLED) {
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
  return TIER_MODEL_MAPPINGS as Record<string, ModelMapping[]>;
}

/**
 * Get model mappings for a specific tier.
 */
export async function getModelMappingsForTier(tier: string): Promise<ModelMapping[]> {
  if (PROVIDERS_API_ENABLED) {
    const mappings = await getTierMappings();
    return mappings[tier] ?? [];
  }

  const { getModelMappingsForTier: localGetMappings } = await import('../internal/providers/lib/alia-models.js');
  return localGetMappings(tier as any);
}

// ============== PROVIDER HEALTH ==============

/**
 * Get all provider health metrics.
 */
export async function getAllProviderHealth(): Promise<HealthMetrics[]> {
  if (PROVIDERS_API_ENABLED) {
    return apiGet<HealthMetrics[]>('/api/health');
  }

  const { getAllProviderHealth: localGetAll } = await import('../internal/providers/lib/provider-health.js');
  return localGetAll();
}

/**
 * Get health for a specific provider/model.
 */
export async function getProviderHealth(provider: string, modelId: string): Promise<HealthMetrics> {
  if (PROVIDERS_API_ENABLED) {
    return apiGet<HealthMetrics>(`/api/health?provider=${encodeURIComponent(provider)}&modelId=${encodeURIComponent(modelId)}`);
  }

  const { getProviderHealth: localGet } = await import('../internal/providers/lib/provider-health.js');
  return localGet(provider, modelId);
}

// ============== BILLING DATA ==============

/**
 * Get plans.
 */
export async function getPlans(filter?: Record<string, any>): Promise<any[]> {
  if (PROVIDERS_API_ENABLED) {
    const data = await apiGet<{ plans: any[] }>('/api/billing?type=plans');
    const plans = data.plans ?? [];
    if (!filter) return plans;
    return plans.filter((p: any) => Object.entries(filter).every(([k, v]) => p[k] === v));
  }

  const { Plan } = await import('../internal/providers/models/plan.js');
  return Plan.find(filter || {}).lean();
}

/**
 * Get credit packages.
 */
export async function getCreditPackages(active?: boolean): Promise<any[]> {
  if (PROVIDERS_API_ENABLED) {
    const query = active !== undefined ? `&active=${active}` : '';
    const data = await apiGet<{ packages: any[] }>(`/api/billing?type=packages${query}`);
    return data.packages ?? [];
  }

  const { CreditPackage } = await import('../internal/providers/models/credit-package.js');
  const query: any = {};
  if (active !== undefined) query.isActive = active;
  return CreditPackage.find(query).lean();
}

/**
 * Get features.
 */
export async function getFeatures(): Promise<any[]> {
  if (PROVIDERS_API_ENABLED) {
    const data = await apiGet<{ features: any[] }>('/api/billing?type=features');
    return data.features ?? [];
  }

  const { Feature } = await import('../internal/providers/models/feature.js');
  return Feature.find({}).lean();
}

/**
 * Get plan features.
 */
export async function getPlanFeatures(planId?: string): Promise<any[]> {
  if (PROVIDERS_API_ENABLED) {
    const query = planId ? `&planId=${encodeURIComponent(planId)}` : '';
    const data = await apiGet<{ planFeatures: any[] }>(`/api/billing?type=plan-features${query}`);
    return data.planFeatures ?? [];
  }

  const { PlanFeature } = await import('../internal/providers/models/plan-feature.js');
  const query: any = {};
  if (planId) query.planId = planId;
  return PlanFeature.find(query).lean();
}

/**
 * Update a plan (e.g. to persist auto-created Stripe price IDs).
 */
export async function updatePlan(planId: string, updates: Record<string, any>): Promise<any> {
  if (PROVIDERS_API_ENABLED) {
    return apiPatch(`/v1/plans/${planId}`, updates);
  }

  const { Plan } = await import('../internal/providers/models/plan.js');
  return Plan.findOneAndUpdate({ planId }, { $set: updates }, { new: true }).lean();
}

// ============== KEY MANAGEMENT ==============

/**
 * Mark a provider key as credit-exhausted.
 * Routes through providers-api when enabled so it operates on the correct database.
 */
export async function markKeyCreditExhausted(keyId: string): Promise<void> {
  if (!keyId) return;
  if (PROVIDERS_API_ENABLED) {
    apiPost('/api/report', { keyId, provider: '', modelId: '', success: false, reason: 'billing' }).catch(() => {});
    return;
  }
  const { markKeyCreditExhausted: localMark } = await import('../internal/providers/lib/key-manager.js');
  localMark(keyId).catch(() => {});
}

// ============== CACHE WARMUP ==============

/**
 * Warm up the in-memory cache at startup.
 */
export async function warmupProvidersClient(): Promise<void> {
  if (!PROVIDERS_API_ENABLED) {
    log.general.info('Providers client using local modules — no warmup needed');
    return;
  }

  try {
    await getTierMappings();
    log.general.info('Providers client cache warmed up');
  } catch (error: any) {
    log.general.warn({ err: error }, 'Failed to warm up providers client cache (providers API may not be ready)');
  }
}
