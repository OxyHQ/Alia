/**
 * Providers Service Client
 * Client library for communicating with the alia-providers microservice
 */

import crypto from 'crypto';

const PROVIDERS_SERVICE_URL = process.env.PROVIDERS_SERVICE_URL || 'http://localhost:3001';
const SERVICE_SECRET = process.env.SERVICE_SECRET || '';
const SERVICE_NAME = 'alia-api';

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

export interface ProxyRequest {
  modelId: string;
  messages: any[];
  tools?: any[];
  config?: {
    temperature?: number;
    maxTokens?: number;
  };
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

export class ProvidersServiceClient {
  private baseUrl: string;
  private secret: string;
  private serviceName: string;

  constructor() {
    this.baseUrl = PROVIDERS_SERVICE_URL;
    this.secret = SERVICE_SECRET;
    this.serviceName = SERVICE_NAME;

    if (!this.secret) {
      console.warn('⚠️  SERVICE_SECRET not configured! Service-to-service auth will fail.');
    }
  }

  /**
   * Generate HMAC authentication headers
   */
  private getAuthHeaders(): Record<string, string> {
    const timestamp = Date.now().toString();
    const payload = JSON.stringify({ timestamp, service: this.serviceName });
    const signature = crypto.createHmac('sha256', this.secret).update(payload).digest('hex');

    return {
      'X-Service-Name': this.serviceName,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Resolve an Alia model to a concrete provider/model
   */
  async resolveModel(
    aliasModelId: string,
    options: {
      estimatedTokens?: number;
      skipProviders?: string[];
    } = {}
  ): Promise<ResolvedModel | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/providers/resolve`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          aliasModelId,
          estimatedTokens: options.estimatedTokens || 0,
          skipProviders: options.skipProviders || [],
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        console.error('Failed to resolve model:', error);
        return null;
      }

      const result = await response.json();
      return result.success ? result.data : null;
    } catch (error: any) {
      console.error('Error resolving model:', error.message);
      return null;
    }
  }

  /**
   * Proxy a request to a specific provider
   * Returns a ReadableStream for streaming responses
   */
  async proxyRequest(provider: string, request: ProxyRequest): Promise<ReadableStream | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/providers/${provider}/proxy`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        console.error('Failed to proxy request:', error);
        return null;
      }

      return response.body;
    } catch (error: any) {
      console.error('Error proxying request:', error.message);
      return null;
    }
  }

  /**
   * Record health metrics (success/failure)
   */
  async recordHealth(metrics: {
    provider: string;
    modelId: string;
    success: boolean;
    latencyMs?: number;
    errorCode?: string;
  }): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/v1/providers/health/record`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(metrics),
      });
    } catch (error: any) {
      // Don't throw - health recording failures shouldn't break requests
      console.error('Failed to record health:', error.message);
    }
  }

  /**
   * Get health status for a provider/model
   */
  async getHealth(provider: string, modelId: string): Promise<HealthMetrics | null> {
    try {
      const response = await fetch(
        `${this.baseUrl}/v1/providers/health?provider=${provider}&modelId=${modelId}`,
        {
          headers: this.getAuthHeaders(),
        }
      );

      if (!response.ok) {
        return null;
      }

      const result = await response.json();
      return result.success ? result.data : null;
    } catch (error: any) {
      console.error('Error getting health:', error.message);
      return null;
    }
  }

  /**
   * Get all provider health metrics
   */
  async getAllHealth(): Promise<HealthMetrics[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/providers/health`, {
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        return [];
      }

      const result = await response.json();
      return result.success ? result.data : [];
    } catch (error: any) {
      console.error('Error getting all health:', error.message);
      return [];
    }
  }

  /**
   * Check if a provider is available (circuit breaker status)
   */
  async isProviderAvailable(provider: string, modelId: string): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.baseUrl}/v1/providers/available?provider=${provider}&modelId=${modelId}`,
        {
          headers: this.getAuthHeaders(),
        }
      );

      if (!response.ok) {
        return false;
      }

      const result = await response.json();
      return result.success && result.data.available;
    } catch (error: any) {
      console.error('Error checking availability:', error.message);
      return false;
    }
  }

  /**
   * List all models
   */
  async listModels(filters: {
    provider?: string;
    aliaTier?: string;
    active?: boolean;
  } = {}): Promise<any[]> {
    try {
      const params = new URLSearchParams();
      if (filters.provider) params.set('provider', filters.provider);
      if (filters.aliaTier) params.set('aliaTier', filters.aliaTier);
      if (filters.active !== undefined) params.set('active', filters.active.toString());

      const response = await fetch(`${this.baseUrl}/v1/models?${params}`, {
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        return [];
      }

      const result = await response.json();
      return result.success ? result.data : [];
    } catch (error: any) {
      console.error('Error listing models:', error.message);
      return [];
    }
  }

  /**
   * Get model by provider and modelId
   */
  async getModel(provider: string, modelId: string): Promise<any | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models/${provider}/${modelId}`, {
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        return null;
      }

      const result = await response.json();
      return result.success ? result.data : null;
    } catch (error: any) {
      console.error('Error getting model:', error.message);
      return null;
    }
  }
}

// Singleton instance
export const providersClient = new ProvidersServiceClient();
