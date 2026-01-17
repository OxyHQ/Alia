import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { generateAPIUrl } from '../generate-api-url';
import { useAuthStore } from '../stores/auth-store';

export interface DeveloperApp {
  _id: string;
  userId: string;
  name: string;
  description?: string;
  websiteUrl?: string;
  redirectUrls: string[];
  icon?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeveloperApiKey {
  _id: string;
  userId: string;
  appId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt?: string;
  lastUsedAt?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  key?: string; // Only present when creating
}

export interface UsageSummary {
  totalRequests: number;
  totalTokens: number;
  totalCredits: number;
  avgResponseTime: number;
  successfulRequests: number;
  errorRequests: number;
}

export interface UsageByDay {
  _id: string;
  requests: number;
  tokens: number;
  credits: number;
}

export interface UsageByEndpoint {
  _id: string;
  requests: number;
  tokens: number;
}

export interface AppUsageStats {
  summary: UsageSummary;
  byDay: UsageByDay[];
  byEndpoint: UsageByEndpoint[];
}

export interface DeveloperStats {
  totalApps: number;
  activeApps: number;
  totalKeys: number;
  activeKeys: number;
  last30Days: {
    totalRequests: number;
    totalTokens: number;
    totalCredits: number;
  };
}

function getAPIHeaders(): HeadersInit {
  const token = useAuthStore.getState().token;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// ======================
// Apps
// ======================

async function fetchApps(): Promise<DeveloperApp[]> {
  const apiUrl = generateAPIUrl('/developer/apps');
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch apps');
  }

  const data = await response.json();
  return data.apps;
}

export function useApps() {
  return useQuery({
    queryKey: ['developer-apps'],
    queryFn: fetchApps,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
  });
}

async function fetchApp(id: string): Promise<DeveloperApp> {
  const apiUrl = generateAPIUrl(`/developer/apps/${id}`);
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch app');
  }

  const data = await response.json();
  return data.app;
}

export function useApp(id: string) {
  return useQuery({
    queryKey: ['developer-app', id],
    queryFn: () => fetchApp(id),
    enabled: !!id,
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 1,
  });
}

export function useCreateApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: Partial<DeveloperApp>) => {
      const apiUrl = generateAPIUrl('/developer/apps');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: getAPIHeaders(),
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create app');
      }

      const result = await response.json();
      return result.app;
    },
    onSuccess: (newApp) => {
      // Add to apps list cache
      queryClient.setQueryData<DeveloperApp[]>(['developer-apps'], (old) => {
        if (!old) return [newApp];
        return [newApp, ...old];
      });

      // Set individual app cache
      queryClient.setQueryData(['developer-app', newApp._id], newApp);

      // Invalidate stats
      queryClient.invalidateQueries({ queryKey: ['developer-stats'] });
    },
  });
}

export function useUpdateApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<DeveloperApp> }) => {
      const apiUrl = generateAPIUrl(`/developer/apps/${id}`);
      const response = await fetch(apiUrl, {
        method: 'PATCH',
        headers: getAPIHeaders(),
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update app');
      }

      const result = await response.json();
      return result.app;
    },
    onSuccess: (updatedApp) => {
      // Update apps list cache
      queryClient.setQueryData<DeveloperApp[]>(['developer-apps'], (old) => {
        if (!old) return [updatedApp];
        return old.map((app) => (app._id === updatedApp._id ? updatedApp : app));
      });

      // Update individual app cache
      queryClient.setQueryData(['developer-app', updatedApp._id], updatedApp);
    },
  });
}

export function useDeleteApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const apiUrl = generateAPIUrl(`/developer/apps/${id}`);
      const response = await fetch(apiUrl, {
        method: 'DELETE',
        headers: getAPIHeaders(),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete app');
      }

      return id;
    },
    onSuccess: (id) => {
      // Remove from apps list cache
      queryClient.setQueryData<DeveloperApp[]>(['developer-apps'], (old) => {
        if (!old) return [];
        return old.filter((app) => app._id !== id);
      });

      // Remove individual app cache
      queryClient.removeQueries({ queryKey: ['developer-app', id] });

      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: ['developer-keys', id] });
      queryClient.invalidateQueries({ queryKey: ['developer-stats'] });
    },
  });
}

// ======================
// API Keys
// ======================

async function fetchApiKeys(appId: string): Promise<DeveloperApiKey[]> {
  const apiUrl = generateAPIUrl(`/developer/apps/${appId}/keys`);
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch API keys');
  }

  const data = await response.json();
  return data.keys;
}

export function useApiKeys(appId: string) {
  return useQuery({
    queryKey: ['developer-keys', appId],
    queryFn: () => fetchApiKeys(appId),
    enabled: !!appId,
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 1,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      appId,
      data,
    }: {
      appId: string;
      data: { name: string; scopes: string[]; expiresAt?: string };
    }) => {
      const apiUrl = generateAPIUrl(`/developer/apps/${appId}/keys`);
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: getAPIHeaders(),
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create API key');
      }

      const result = await response.json();
      return { appId, apiKey: result.apiKey, warning: result.warning };
    },
    onSuccess: ({ appId, apiKey }) => {
      // Add to keys list cache
      queryClient.setQueryData<DeveloperApiKey[]>(['developer-keys', appId], (old) => {
        if (!old) return [apiKey];
        return [apiKey, ...old];
      });

      // Invalidate stats
      queryClient.invalidateQueries({ queryKey: ['developer-stats'] });
    },
  });
}

export function useUpdateApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      appId,
      keyId,
      data,
    }: {
      appId: string;
      keyId: string;
      data: Partial<DeveloperApiKey>;
    }) => {
      const apiUrl = generateAPIUrl(`/developer/apps/${appId}/keys/${keyId}`);
      const response = await fetch(apiUrl, {
        method: 'PATCH',
        headers: getAPIHeaders(),
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update API key');
      }

      const result = await response.json();
      return { appId, apiKey: result.apiKey };
    },
    onSuccess: ({ appId, apiKey }) => {
      // Update keys list cache
      queryClient.setQueryData<DeveloperApiKey[]>(['developer-keys', appId], (old) => {
        if (!old) return [apiKey];
        return old.map((key) => (key._id === apiKey._id ? apiKey : key));
      });
    },
  });
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ appId, keyId }: { appId: string; keyId: string }) => {
      const apiUrl = generateAPIUrl(`/developer/apps/${appId}/keys/${keyId}`);
      const response = await fetch(apiUrl, {
        method: 'DELETE',
        headers: getAPIHeaders(),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete API key');
      }

      return { appId, keyId };
    },
    onSuccess: ({ appId, keyId }) => {
      // Remove from keys list cache
      queryClient.setQueryData<DeveloperApiKey[]>(['developer-keys', appId], (old) => {
        if (!old) return [];
        return old.filter((key) => key._id !== keyId);
      });

      // Invalidate stats
      queryClient.invalidateQueries({ queryKey: ['developer-stats'] });
    },
  });
}

// ======================
// Usage Stats
// ======================

async function fetchAppUsage(appId: string, period: string): Promise<AppUsageStats> {
  const apiUrl = generateAPIUrl(`/developer/apps/${appId}/usage?period=${period}`);
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch usage stats');
  }

  return await response.json();
}

export function useAppUsage(appId: string, period: string = '7d') {
  return useQuery({
    queryKey: ['developer-usage', appId, period],
    queryFn: () => fetchAppUsage(appId, period),
    enabled: !!appId,
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
  });
}

async function fetchKeyUsage(
  appId: string,
  keyId: string,
  period: string
): Promise<AppUsageStats> {
  const apiUrl = generateAPIUrl(
    `/developer/apps/${appId}/keys/${keyId}/usage?period=${period}`
  );
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch key usage stats');
  }

  return await response.json();
}

export function useKeyUsage(appId: string, keyId: string, period: string = '7d') {
  return useQuery({
    queryKey: ['developer-key-usage', appId, keyId, period],
    queryFn: () => fetchKeyUsage(appId, keyId, period),
    enabled: !!appId && !!keyId,
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
  });
}

async function fetchDeveloperStats(): Promise<DeveloperStats> {
  const apiUrl = generateAPIUrl('/developer/stats');
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch developer stats');
  }

  return await response.json();
}

export function useDeveloperStats() {
  return useQuery({
    queryKey: ['developer-stats'],
    queryFn: fetchDeveloperStats,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
  });
}
