/**
 * The developer application and credential store.
 *
 * ## Creation is not here, and its absence is the point
 *
 * ADR 0001 gives developer applications and credentials to Oxy, and #160 closed
 * every path by which Alia issued one: `POST /developer/apps` and
 * `POST /developer/apps/:appId/keys` answer `410 Gone` with
 * `{ error: "issuance_closed" }`. `useCreateApp` and `useCreateApiKey` are
 * deleted rather than left pointing at those routes, because a mutation whose
 * only possible outcome is a toast reading "Failed to create app" is worse for
 * its user than no button at all.
 *
 * What #160 left working is what remains here: read, update (name, scopes,
 * active flag, rate limits) and revoke, for the whole compatibility window —
 * `docs/migration/compatibility-window.md` section (c) keeps revocation
 * available deliberately, since removing it mid-migration is a security
 * regression.
 *
 * **Rotation is not missing, it does not exist.** No endpoint has ever
 * regenerated an `alia_sk_*` secret in place, and `DeveloperApiKeyUpdate` in the
 * API cannot name `keyHash`, so one cannot be added without a backend change
 * that is itself forbidden. A rotate button here would be a control with nothing
 * behind it. `epic-139-status.json` row 459 still says to keep "rotate and
 * revoke"; it was measured before #160 landed and is stale on that word.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { useCurrentWorkspaceId } from './use-workspace';
import apiClient from '@/lib/api/client';

export interface DeveloperApp {
  _id: string;
  userId: string;
  name: string;
  description?: string;
  websiteUrl?: string;
  redirectUrls: Array<string>;
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
  scopes: Array<string>;
  expiresAt?: string;
  lastUsedAt?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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
  byDay: Array<UsageByDay>;
  byEndpoint: Array<UsageByEndpoint>;
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

// Internal: workspace ID for query key cache separation
function useWorkspaceKey() {
  const [workspaceId] = useCurrentWorkspaceId();
  return workspaceId;
}

// ======================
// Apps
// ======================

export function useApps() {
  const { isAuthenticated, isReady } = useAuth();
  const workspaceId = useWorkspaceKey();

  return useQuery({
    queryKey: ['developer-apps', workspaceId],
    queryFn: async () => {
      const response = await apiClient.get('/developer/apps');
      return response.data.apps as Array<DeveloperApp>;
    },
    staleTime: 1000 * 60 * 5,
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

export function useApp(id: string) {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-app', id],
    queryFn: async () => {
      const response = await apiClient.get(`/developer/apps/${id}`);
      return response.data.app as DeveloperApp;
    },
    enabled: isReady && isAuthenticated && !!id,
    staleTime: 1000 * 60 * 2,
    retry: 1,
  });
}

export function useUpdateApp() {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceKey();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<DeveloperApp> }) => {
      const response = await apiClient.patch(`/developer/apps/${id}`, data);
      return response.data.app as DeveloperApp;
    },
    onSuccess: (updatedApp) => {
      queryClient.setQueryData<Array<DeveloperApp>>(['developer-apps', workspaceId], (old) => {
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
      queryClient.invalidateQueries({ queryKey: ['developer-apps'] });
      queryClient.removeQueries({ queryKey: ['developer-app', id] });
      queryClient.invalidateQueries({ queryKey: ['developer-keys', id] });
      queryClient.invalidateQueries({ queryKey: ['developer-stats'] });
    },
  });
}

// ======================
// API Keys
// ======================

export function useApiKeys(appId: string) {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-keys', appId],
    queryFn: async () => {
      const response = await apiClient.get(`/developer/apps/${appId}/keys`);
      return response.data.keys as Array<DeveloperApiKey>;
    },
    enabled: isReady && isAuthenticated && !!appId,
    staleTime: 1000 * 60 * 2,
    retry: 1,
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
      queryClient.setQueryData<Array<DeveloperApiKey>>(['developer-keys', appId], (old) => {
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
      queryClient.setQueryData<Array<DeveloperApiKey>>(['developer-keys', appId], (old) => {
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

export function useGlobalUsage(period: string = '7d') {
  const { isAuthenticated, isReady } = useAuth();
  const workspaceId = useWorkspaceKey();

  return useQuery({
    queryKey: ['developer-global-usage', workspaceId, period],
    queryFn: async () => {
      const response = await apiClient.get('/developer/usage', { params: { period } });
      return response.data as AppUsageStats;
    },
    enabled: isReady && isAuthenticated,
    staleTime: 1000 * 60,
    retry: 1,
  });
}

export function useAppUsage(appId: string, period: string = '7d') {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-usage', appId, period],
    queryFn: async () => {
      const response = await apiClient.get(`/developer/apps/${appId}/usage`, { params: { period } });
      return response.data as AppUsageStats;
    },
    enabled: isReady && isAuthenticated && !!appId,
    staleTime: 1000 * 60,
    retry: 1,
  });
}

export function useKeyUsage(appId: string, keyId: string, period: string = '7d') {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['developer-key-usage', appId, keyId, period],
    queryFn: async () => {
      const response = await apiClient.get(`/developer/apps/${appId}/keys/${keyId}/usage`, { params: { period } });
      return response.data as AppUsageStats;
    },
    enabled: isReady && isAuthenticated && !!appId && !!keyId,
    staleTime: 1000 * 60,
    retry: 1,
  });
}

export function useDeveloperStats() {
  const { isAuthenticated, isReady } = useAuth();
  const workspaceId = useWorkspaceKey();

  return useQuery({
    queryKey: ['developer-stats', workspaceId],
    queryFn: async () => {
      const response = await apiClient.get('/developer/stats');
      return response.data as DeveloperStats;
    },
    staleTime: 1000 * 60 * 5,
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
  /**
   * Null until the model has served something. `/models/stats` reports absence
   * rather than 100% for a model whose providers have never been called, so
   * these four arrive as null together with `totalRequests: 0`.
   */
  avgLatencyMs: number | null;
  uptime: number | null;
  successRate: number | null;
  totalRequests: number;
  isHealthy: boolean | null;
  supportsTools: boolean;
  supportsVision: boolean;
  maxTokens: number;
}

export interface ModelsStatsResponse {
  models: Array<ModelStats>;
  count: number;
  timestamp: string;
}

export function useModelsStats() {
  return useQuery({
    queryKey: ['models-stats'],
    queryFn: async () => {
      const response = await apiClient.get('/models/stats');
      return response.data as ModelsStatsResponse;
    },
    staleTime: 1000 * 60 * 2,
    retry: 2,
  });
}
