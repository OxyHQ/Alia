/**
 * Internal Providers Client - Direct function calls (no HTTP)
 */
import { resolveAliaModel } from '../internal/providers/lib/model-resolver.js';
import {
  getProviderHealth,
  getAllProviderHealth,
  recordSuccess,
  recordFailure,
  isProviderAvailable
} from '../internal/providers/lib/provider-health.js';
import { ModelConfig } from '../internal/providers/models/model-config.js';
import { loadProviderKeys } from '../internal/providers/lib/key-manager.js';

export interface ResolvedModel {
  aliasModelId: string;
  provider: string;
  modelId: string;
  keyId: string | null;
  keyPrefix: string | null;
  isFallback: boolean;
  fallbackIndex: number;
  capabilities: {
    vision: boolean;
    audio: boolean;
    codeExecution: boolean;
    webSearch: boolean;
  };
  pricing: any;
}

export interface HealthMetrics {
  provider: string;
  modelId: string;
  isHealthy: boolean;
  circuitState: 'closed' | 'open' | 'half-open';
  successRate: number;
  averageLatencyMs: number;
  lastFailure: Date | null;
  consecutiveFailures: number;
}

export class InternalProvidersClient {
  async resolveModel(
    aliasModelId: string,
    options: {
      estimatedTokens?: number;
      skipProviders?: string[];
    } = {}
  ): Promise<ResolvedModel | null> {
    const keyPool = await loadProviderKeys(null);
    const skipSet = new Set(options.skipProviders || []);
    return resolveAliaModel(aliasModelId, keyPool, options.estimatedTokens, skipSet);
  }

  async recordHealth(metrics: {
    provider: string;
    modelId: string;
    success: boolean;
    latencyMs?: number;
    errorCode?: string;
  }): Promise<void> {
    if (metrics.success) {
      await recordSuccess(metrics.provider, metrics.modelId, metrics.latencyMs || 0);
    } else {
      await recordFailure(metrics.provider, metrics.modelId, metrics.errorCode);
    }
  }

  async getHealth(provider: string, modelId: string): Promise<HealthMetrics | null> {
    return getProviderHealth(provider, modelId);
  }

  async getAllHealth(): Promise<HealthMetrics[]> {
    return getAllProviderHealth();
  }

  async isProviderAvailable(provider: string, modelId: string): Promise<boolean> {
    return isProviderAvailable(provider, modelId);
  }

  async listModels(filters: {
    provider?: string;
    aliaTier?: string;
    active?: boolean;
  } = {}): Promise<any[]> {
    const query: any = {};
    if (filters.provider) query.provider = filters.provider;
    if (filters.aliaTier) query.aliaTier = filters.aliaTier;
    if (filters.active !== undefined) query.isActive = filters.active;
    return ModelConfig.find(query).sort({ provider: 1, priority: 1 });
  }

  async getModel(provider: string, modelId: string): Promise<any | null> {
    return ModelConfig.findOne({ provider, modelId });
  }
}

export const internalProvidersClient = new InternalProvidersClient();
