/**
 * API Client for Alia Providers Service
 * Uses OxyHQ authentication for admin access
 */

const API_BASE_URL = import.meta.env.VITE_PROVIDERS_API_URL || 'http://localhost:3002';

class ProvidersAPIClient {
  private baseUrl: string;
  private getAccessToken: (() => Promise<string | null>) | null = null;

  constructor() {
    this.baseUrl = API_BASE_URL;
  }

  /**
   * Set the function to retrieve the current access token
   * This will be called by the auth setup
   */
  setTokenGetter(getter: () => Promise<string | null>) {
    this.getAccessToken = getter;
  }

  /**
   * Get authentication headers (OAuth Bearer token from OxyHQ)
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.getAccessToken) {
      const token = await this.getAccessToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    return headers;
  }

  /**
   * Generic request method
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const authHeaders = await this.getAuthHeaders();

    const response = await fetch(url, {
      ...options,
      headers: {
        ...authHeaders,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));

      // If 401, user needs to re-authenticate
      if (response.status === 401) {
        // Trigger logout/re-login
        window.dispatchEvent(new CustomEvent('auth:unauthorized'));
      }

      // If 403, user doesn't have access
      if (response.status === 403) {
        throw new Error('Access denied. Only admin users can access this resource.');
      }

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
    const { apiKey, ...rest } = data;
    return this.request('/v1/keys', {
      method: 'POST',
      body: JSON.stringify({ ...rest, key: apiKey }),
    });
  }

  async updateKey(
    keyId: string,
    data: Partial<{
      name: string;
      isActive: boolean;
      priority: number;
      rateLimit: unknown;
    }>
  ) {
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

  async createModel(data: unknown) {
    return this.request('/v1/models', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateModel(provider: string, modelId: string, data: unknown) {
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
