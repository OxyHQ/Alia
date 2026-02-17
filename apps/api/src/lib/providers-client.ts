/**
 * Providers API Client
 *
 * Thin HTTP client for the alia-providers-api service.
 * Replaces direct imports from internal/providers/* with API calls.
 * Uses HMAC service auth for all requests.
 */

import crypto from 'crypto';
import { log } from './logger.js';

const PROVIDERS_API_URL = process.env.PROVIDERS_API_URL || 'http://localhost:9091';
const SERVICE_NAME = 'alia-api';
const SERVICE_SECRET = process.env.SERVICE_SECRET;

// ============== AUTH ==============

function generateAuthHeaders(): Record<string, string> {
  if (!SERVICE_SECRET) {
    throw new Error('SERVICE_SECRET is not configured');
  }
  const timestamp = Date.now().toString();
  const payload = JSON.stringify({ timestamp, service: SERVICE_NAME });
  const signature = crypto.createHmac('sha256', SERVICE_SECRET).update(payload).digest('hex');

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

// ============== IN-MEMORY CACHE ==============

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
  skipProviders: Set<string> = new Set()
): Promise<ResolvedModel | null> {
  try {
    return await apiPost<ResolvedModel>('/api/resolve', {
      model,
      estimatedTokens: tokens,
      skipProviders: [...skipProviders],
    });
  } catch (error: any) {
    if (error.status === 503) return null;
    throw error;
  }
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
  return apiPost<T>('/api/call', options);
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
  apiPost('/api/report', {
    keyId,
    provider,
    modelId,
    success,
    ...opts,
  }).catch((err: any) => {
    log.general.warn({ err }, 'Failed to report model usage');
  });
}

// ============== MODEL DATA ==============

/**
 * Get all alia models (cached).
 */
export async function getAllAliaModels(): Promise<AliaModel[]> {
  if (isCacheValid(modelsCache)) return modelsCache.data;

  const data = await apiGet<{ models: AliaModel[] }>('/api/models');
  const models = data.models;
  modelsCache = { data: models, expiresAt: Date.now() + CACHE_TTL };
  return models;
}

/**
 * Get all alia models with availability (not cached — checks health).
 */
export async function getAvailableModels(): Promise<AliaModelWithAvailability[]> {
  const data = await apiGet<{ models: AliaModelWithAvailability[] }>('/api/models?available=true');
  return data.models;
}

/**
 * Get a specific alia model by ID.
 */
export async function getAliaModel(modelId: string): Promise<AliaModel | null> {
  const models = await getAllAliaModels();
  return models.find(m => m.id === modelId) ?? null;
}

/**
 * Synchronous model lookup from cache (returns null if cache cold).
 */
export function getAliaModelSync(modelId: string): AliaModel | null {
  if (!isCacheValid(modelsCache)) return null;
  return modelsCache.data.find(m => m.id === modelId) ?? null;
}

/**
 * Check if a model ID is an alia model.
 */
export async function isAliaModel(modelId: string): Promise<boolean> {
  const models = await getAllAliaModels();
  return models.some(m => m.id === modelId);
}

/**
 * Get all alia models by category.
 */
export async function getAliaModelsByCategory(category: string): Promise<AliaModel[]> {
  const models = await getAllAliaModels();
  return models.filter(m => m.category === category);
}

/**
 * Get default model for a category.
 */
export async function getDefaultModelForCategory(category: string): Promise<AliaModel | null> {
  const models = await getAliaModelsByCategory(category);
  if (models.length === 0) return null;
  return models.reduce((best, m) => m.creditMultiplier < best.creditMultiplier ? m : best);
}

/**
 * Get the default alia model ID.
 */
export function getDefaultAliaModel(): string {
  return 'alia-v1';
}

// ============== TIER MAPPINGS ==============

/**
 * Get tier-to-model mappings (cached).
 */
export async function getTierMappings(): Promise<Record<string, ModelMapping[]>> {
  if (isCacheValid(tierMappingsCache)) return tierMappingsCache.data;

  const data = await apiGet<{ models: AliaModel[]; tierMappings: Record<string, ModelMapping[]> }>(
    '/api/models?tierMappings=true'
  );
  const mappings = data.tierMappings;
  tierMappingsCache = { data: mappings, expiresAt: Date.now() + CACHE_TTL };

  // Also update models cache as a side effect
  if (data.models) {
    modelsCache = { data: data.models, expiresAt: Date.now() + CACHE_TTL };
  }

  return mappings;
}

/**
 * Get model mappings for a specific tier.
 */
export async function getModelMappingsForTier(tier: string): Promise<ModelMapping[]> {
  const mappings = await getTierMappings();
  return mappings[tier] ?? [];
}

// ============== PROVIDER HEALTH ==============

/**
 * Get all provider health metrics.
 */
export async function getAllProviderHealth(): Promise<HealthMetrics[]> {
  return apiGet<HealthMetrics[]>('/api/health');
}

/**
 * Get health for a specific provider/model.
 */
export async function getProviderHealth(provider: string, modelId: string): Promise<HealthMetrics> {
  return apiGet<HealthMetrics>(`/api/health?provider=${encodeURIComponent(provider)}&modelId=${encodeURIComponent(modelId)}`);
}

// ============== BILLING DATA ==============

/**
 * Get plans from the providers API.
 */
export async function getPlans(filter?: Record<string, any>): Promise<any[]> {
  const data = await apiGet<{ plans: any[] }>('/api/billing?type=plans');
  const plans = data.plans ?? [];
  if (!filter) return plans;
  return plans.filter((p: any) => Object.entries(filter).every(([k, v]) => p[k] === v));
}

/**
 * Get credit packages from the providers API.
 */
export async function getCreditPackages(active?: boolean): Promise<any[]> {
  const query = active !== undefined ? `&active=${active}` : '';
  const data = await apiGet<{ packages: any[] }>(`/api/billing?type=packages${query}`);
  return data.packages ?? [];
}

/**
 * Get features from the providers API.
 */
export async function getFeatures(): Promise<any[]> {
  const data = await apiGet<{ features: any[] }>('/api/billing?type=features');
  return data.features ?? [];
}

/**
 * Get plan features from the providers API.
 */
export async function getPlanFeatures(planId?: string): Promise<any[]> {
  const query = planId ? `&planId=${encodeURIComponent(planId)}` : '';
  const data = await apiGet<{ planFeatures: any[] }>(`/api/billing?type=plan-features${query}`);
  return data.planFeatures ?? [];
}

// ============== CACHE WARMUP ==============

/**
 * Warm up the in-memory cache at startup.
 * Call this during main API initialization.
 */
export async function warmupProvidersClient(): Promise<void> {
  try {
    // Fetch models + tier mappings in a single call
    await getTierMappings();
    log.general.info('Providers client cache warmed up');
  } catch (error: any) {
    log.general.warn({ err: error }, 'Failed to warm up providers client cache (providers API may not be ready)');
  }
}
