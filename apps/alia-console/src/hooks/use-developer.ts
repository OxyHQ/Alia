import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import apiClient from '@/lib/api/client';

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

// ======================
// Apps
// ======================

async function fetchApps(): Promise<DeveloperApp[]> {
  const response = await apiClient.get('/developer/apps');
  return response.data.apps;
}

export function useApps() {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-apps'],
    queryFn: fetchApps,
    staleTime: 1000 * 60 * 5,
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

async function fetchApp(id: string): Promise<DeveloperApp> {
  const response = await apiClient.get(`/developer/apps/${id}`);
  return response.data.app;
}

export function useApp(id: string) {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-app', id],
    queryFn: () => fetchApp(id),
    enabled: isReady && isAuthenticated && !!id,
    staleTime: 1000 * 60 * 2,
    retry: 1,
  });
}

export function useCreateApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: Partial<DeveloperApp>) => {
      const response = await apiClient.post('/developer/apps', data);
      return response.data.app;
    },
    onSuccess: (newApp) => {
      queryClient.setQueryData<DeveloperApp[]>(['developer-apps'], (old) => {
        if (!old) return [newApp];
        return [newApp, ...old];
      });
      queryClient.setQueryData(['developer-app', newApp._id], newApp);
      queryClient.invalidateQueries({ queryKey: ['developer-stats'] });
    },
  });
}

export function useUpdateApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<DeveloperApp> }) => {
      const response = await apiClient.patch(`/developer/apps/${id}`, data);
      return response.data.app;
    },
    onSuccess: (updatedApp) => {
      queryClient.setQueryData<DeveloperApp[]>(['developer-apps'], (old) => {
        if (!old) return [updatedApp];
        return old.map((app) => (app._id === updatedApp._id ? updatedApp : app));
      });
      queryClient.setQueryData(['developer-app', updatedApp._id], updatedApp);
    },
  });
}

export function useDeleteApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/developer/apps/${id}`);
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<DeveloperApp[]>(['developer-apps'], (old) => {
        if (!old) return [];
        return old.filter((app) => app._id !== id);
      });
      queryClient.removeQueries({ queryKey: ['developer-app', id] });
      queryClient.invalidateQueries({ queryKey: ['developer-keys', id] });
      queryClient.invalidateQueries({ queryKey: ['developer-stats'] });
    },
  });
}

// ======================
// API Keys
// ======================

async function fetchApiKeys(appId: string): Promise<DeveloperApiKey[]> {
  const response = await apiClient.get(`/developer/apps/${appId}/keys`);
  return response.data.keys;
}

export function useApiKeys(appId: string) {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-keys', appId],
    queryFn: () => fetchApiKeys(appId),
    enabled: isReady && isAuthenticated && !!appId,
    staleTime: 1000 * 60 * 2,
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
      const response = await apiClient.post(`/developer/apps/${appId}/keys`, data);
      return { appId, apiKey: response.data.apiKey, warning: response.data.warning };
    },
    onSuccess: ({ appId, apiKey }) => {
      queryClient.setQueryData<DeveloperApiKey[]>(['developer-keys', appId], (old) => {
        if (!old) return [apiKey];
        return [apiKey, ...old];
      });
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
      const response = await apiClient.patch(`/developer/apps/${appId}/keys/${keyId}`, data);
      return { appId, apiKey: response.data.apiKey };
    },
    onSuccess: ({ appId, apiKey }) => {
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
      await apiClient.delete(`/developer/apps/${appId}/keys/${keyId}`);
      return { appId, keyId };
    },
    onSuccess: ({ appId, keyId }) => {
      queryClient.setQueryData<DeveloperApiKey[]>(['developer-keys', appId], (old) => {
        if (!old) return [];
        return old.filter((key) => key._id !== keyId);
      });
      queryClient.invalidateQueries({ queryKey: ['developer-stats'] });
    },
  });
}

// ======================
// Usage Stats
// ======================

async function fetchGlobalUsage(period: string): Promise<AppUsageStats> {
  const response = await apiClient.get(`/developer/usage?period=${period}`);
  return response.data;
}

export function useGlobalUsage(period: string = '7d') {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-global-usage', period],
    queryFn: () => fetchGlobalUsage(period),
    enabled: isReady && isAuthenticated,
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
  });
}

async function fetchAppUsage(appId: string, period: string): Promise<AppUsageStats> {
  const response = await apiClient.get(`/developer/apps/${appId}/usage?period=${period}`);
  return response.data;
}

export function useAppUsage(appId: string, period: string = '7d') {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-usage', appId, period],
    queryFn: () => fetchAppUsage(appId, period),
    enabled: isReady && isAuthenticated && !!appId,
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
  });
}

async function fetchKeyUsage(appId: string, keyId: string, period: string): Promise<AppUsageStats> {
  const response = await apiClient.get(
    `/developer/apps/${appId}/keys/${keyId}/usage?period=${period}`
  );
  return response.data;
}

export function useKeyUsage(appId: string, keyId: string, period: string = '7d') {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-key-usage', appId, keyId, period],
    queryFn: () => fetchKeyUsage(appId, keyId, period),
    enabled: isReady && isAuthenticated && !!appId && !!keyId,
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
  });
}

async function fetchDeveloperStats(): Promise<DeveloperStats> {
  const response = await apiClient.get('/developer/stats');
  return response.data;
}

export function useDeveloperStats() {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-stats'],
    queryFn: fetchDeveloperStats,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

// ======================
// Models Stats
// ======================

export interface ModelStats {
  id: string;
  name: string;
  description: string;
  tier: string;
  category: string;
  creditMultiplier: number;
  avgLatencyMs: number;
  uptime: number;
  successRate: number;
  totalRequests: number;
  isHealthy: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  maxTokens: number;
}

export interface ModelsStatsResponse {
  models: ModelStats[];
  count: number;
  timestamp: string;
}

async function fetchModelsStats(): Promise<ModelsStatsResponse> {
  const response = await apiClient.get('/models/stats');
  return response.data;
}

export function useModelsStats() {
  return useQuery({
    queryKey: ['models-stats'],
    queryFn: fetchModelsStats,
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 2,
  });
}
