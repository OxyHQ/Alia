/**
 * API Client for Alia Providers Service
 */

const API_BASE_URL = import.meta.env.VITE_PROVIDERS_API_URL || 'http://localhost:3002';
const SERVICE_NAME = 'alia-admin';

class ProvidersAPIClient {
  private baseUrl: string;
  private serviceName: string;

  constructor() {
    this.baseUrl = API_BASE_URL;
    this.serviceName = SERVICE_NAME;
  }

  /**
   * Generate HMAC authentication headers
   */
  private getAuthHeaders(): Record<string, string> {
    const timestamp = Date.now().toString();

    // In browser, we'll use SubtleCrypto API
    // For now, admin panel should run with proper auth or be protected
    const signature = 'admin-signature'; // TODO: Implement proper HMAC in browser

    return {
      'X-Service-Name': this.serviceName,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Generic request method
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.getAuthHeaders(),
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || error.message || 'Request failed');
    }

    return response.json();
  }

  // ============ PROVIDERS ============

  async getProviderHealth(provider?: string, modelId?: string) {
    const params = new URLSearchParams();
    if (provider) params.set('provider', provider);
    if (modelId) params.set('modelId', modelId);

    return this.request(`/v1/providers/health?${params}`);
  }

  async getAllProviderHealth() {
    return this.request('/v1/providers/health');
  }

  async recordHealth(data: {
    provider: string;
    modelId: string;
    success: boolean;
    latencyMs?: number;
    errorCode?: string;
  }) {
    return this.request('/v1/providers/health/record', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // ============ KEYS ============

  async listKeys(filters?: { provider?: string; environment?: string; active?: boolean }) {
    const params = new URLSearchParams();
    if (filters?.provider) params.set('provider', filters.provider);
    if (filters?.environment) params.set('environment', filters.environment);
    if (filters?.active !== undefined) params.set('active', filters.active.toString());

    return this.request(`/v1/keys?${params}`);
  }

  async getKey(keyId: string) {
    return this.request(`/v1/keys/${keyId}`);
  }

  async createKey(data: {
    name: string;
    provider: string;
    apiKey: string;
    environment?: string;
    isPaid?: boolean;
    tier?: string;
    priority?: number;
    rateLimit?: {
      rpm?: number;
      rpd?: number;
      tpm?: number;
      tpd?: number;
    };
  }) {
    return this.request('/v1/keys', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateKey(keyId: string, data: Partial<{
    name: string;
    isActive: boolean;
    priority: number;
    rateLimit: any;
  }>) {
    return this.request(`/v1/keys/${keyId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteKey(keyId: string) {
    return this.request(`/v1/keys/${keyId}`, {
      method: 'DELETE',
    });
  }

  async rotateKey(keyId: string, newKey: string) {
    return this.request(`/v1/keys/${keyId}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ newKey }),
    });
  }

  async activateKey(keyId: string) {
    return this.request(`/v1/keys/${keyId}/activate`, {
      method: 'POST',
    });
  }

  async deactivateKey(keyId: string) {
    return this.request(`/v1/keys/${keyId}/deactivate`, {
      method: 'POST',
    });
  }

  // ============ MODELS ============

  async listModels(filters?: { provider?: string; aliaTier?: string; active?: boolean }) {
    const params = new URLSearchParams();
    if (filters?.provider) params.set('provider', filters.provider);
    if (filters?.aliaTier) params.set('aliaTier', filters.aliaTier);
    if (filters?.active !== undefined) params.set('active', filters.active.toString());

    return this.request(`/v1/models?${params}`);
  }

  async getModel(provider: string, modelId: string) {
    return this.request(`/v1/models/${provider}/${modelId}`);
  }

  async createModel(data: any) {
    return this.request('/v1/models', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateModel(provider: string, modelId: string, data: any) {
    return this.request(`/v1/models/${provider}/${modelId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteModel(provider: string, modelId: string) {
    return this.request(`/v1/models/${provider}/${modelId}`, {
      method: 'DELETE',
    });
  }

  async getModelsByTier(tier: string) {
    return this.request(`/v1/models/by-tier/${tier}`);
  }
}

export const apiClient = new ProvidersAPIClient();
