import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiClient } from '../api/client';

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

interface DeveloperStore {
  // Apps state
  apps: DeveloperApp[];
  currentApp: DeveloperApp | null;

  // API Keys state
  apiKeys: DeveloperApiKey[];

  // Usage stats state
  usageStats: AppUsageStats | null;
  developerStats: DeveloperStats | null;

  // Loading states
  isLoadingApps: boolean;
  isLoadingKeys: boolean;
  isLoadingUsage: boolean;
  isLoadingStats: boolean;

  // Error states
  error: string | null;

  // App actions
  fetchApps: () => Promise<void>;
  fetchApp: (appId: string) => Promise<void>;
  createApp: (data: Partial<DeveloperApp>) => Promise<DeveloperApp>;
  updateApp: (appId: string, data: Partial<DeveloperApp>) => Promise<DeveloperApp>;
  deleteApp: (appId: string) => Promise<void>;
  setCurrentApp: (app: DeveloperApp | null) => void;

  // API Key actions
  fetchApiKeys: (appId: string) => Promise<void>;
  createApiKey: (appId: string, data: { name: string; scopes: string[]; expiresAt?: string }) => Promise<DeveloperApiKey>;
  updateApiKey: (appId: string, keyId: string, data: Partial<DeveloperApiKey>) => Promise<DeveloperApiKey>;
  deleteApiKey: (appId: string, keyId: string) => Promise<void>;

  // Usage stats actions
  fetchUsageStats: (appId: string, period?: string) => Promise<void>;
  fetchKeyUsageStats: (appId: string, keyId: string, period?: string) => Promise<void>;
  fetchDeveloperStats: () => Promise<void>;

  // Utility actions
  clearError: () => void;
  reset: () => void;
}

export const useDeveloperStore = create<DeveloperStore>()(
  persist(
    (set, get) => ({
      // Initial state
      apps: [],
      currentApp: null,
      apiKeys: [],
      usageStats: null,
      developerStats: null,
      isLoadingApps: false,
      isLoadingKeys: false,
      isLoadingUsage: false,
      isLoadingStats: false,
      error: null,

      // App actions
      fetchApps: async () => {
        set({ isLoadingApps: true, error: null });
        try {
          const response = await apiClient.get('/developer/apps');
          set({ apps: response.data.apps, isLoadingApps: false });
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to fetch apps',
            isLoadingApps: false,
          });
          throw error;
        }
      },

      fetchApp: async (appId: string) => {
        set({ isLoadingApps: true, error: null });
        try {
          const response = await apiClient.get(`/developer/apps/${appId}`);
          set({ currentApp: response.data.app, isLoadingApps: false });
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to fetch app',
            isLoadingApps: false,
          });
          throw error;
        }
      },

      createApp: async (data: Partial<DeveloperApp>) => {
        set({ isLoadingApps: true, error: null });
        try {
          const response = await apiClient.post('/developer/apps', data);
          const newApp = response.data.app;
          set((state) => ({
            apps: [newApp, ...state.apps],
            isLoadingApps: false,
          }));
          return newApp;
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to create app',
            isLoadingApps: false,
          });
          throw error;
        }
      },

      updateApp: async (appId: string, data: Partial<DeveloperApp>) => {
        set({ isLoadingApps: true, error: null });
        try {
          const response = await apiClient.patch(`/developer/apps/${appId}`, data);
          const updatedApp = response.data.app;
          set((state) => ({
            apps: state.apps.map((app) => (app._id === appId ? updatedApp : app)),
            currentApp: state.currentApp?._id === appId ? updatedApp : state.currentApp,
            isLoadingApps: false,
          }));
          return updatedApp;
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to update app',
            isLoadingApps: false,
          });
          throw error;
        }
      },

      deleteApp: async (appId: string) => {
        set({ isLoadingApps: true, error: null });
        try {
          await apiClient.delete(`/developer/apps/${appId}`);
          set((state) => ({
            apps: state.apps.filter((app) => app._id !== appId),
            currentApp: state.currentApp?._id === appId ? null : state.currentApp,
            isLoadingApps: false,
          }));
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to delete app',
            isLoadingApps: false,
          });
          throw error;
        }
      },

      setCurrentApp: (app: DeveloperApp | null) => {
        set({ currentApp: app });
      },

      // API Key actions
      fetchApiKeys: async (appId: string) => {
        set({ isLoadingKeys: true, error: null });
        try {
          const response = await apiClient.get(`/developer/apps/${appId}/keys`);
          set({ apiKeys: response.data.keys, isLoadingKeys: false });
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to fetch API keys',
            isLoadingKeys: false,
          });
          throw error;
        }
      },

      createApiKey: async (appId: string, data: { name: string; scopes: string[]; expiresAt?: string }) => {
        set({ isLoadingKeys: true, error: null });
        try {
          const response = await apiClient.post(`/developer/apps/${appId}/keys`, data);
          const newKey = response.data.apiKey;
          set((state) => ({
            apiKeys: [newKey, ...state.apiKeys],
            isLoadingKeys: false,
          }));
          return newKey;
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to create API key',
            isLoadingKeys: false,
          });
          throw error;
        }
      },

      updateApiKey: async (appId: string, keyId: string, data: Partial<DeveloperApiKey>) => {
        set({ isLoadingKeys: true, error: null });
        try {
          const response = await apiClient.patch(`/developer/apps/${appId}/keys/${keyId}`, data);
          const updatedKey = response.data.apiKey;
          set((state) => ({
            apiKeys: state.apiKeys.map((key) => (key._id === keyId ? updatedKey : key)),
            isLoadingKeys: false,
          }));
          return updatedKey;
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to update API key',
            isLoadingKeys: false,
          });
          throw error;
        }
      },

      deleteApiKey: async (appId: string, keyId: string) => {
        set({ isLoadingKeys: true, error: null });
        try {
          await apiClient.delete(`/developer/apps/${appId}/keys/${keyId}`);
          set((state) => ({
            apiKeys: state.apiKeys.filter((key) => key._id !== keyId),
            isLoadingKeys: false,
          }));
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to delete API key',
            isLoadingKeys: false,
          });
          throw error;
        }
      },

      // Usage stats actions
      fetchUsageStats: async (appId: string, period: string = '7d') => {
        set({ isLoadingUsage: true, error: null });
        try {
          const response = await apiClient.get(`/developer/apps/${appId}/usage?period=${period}`);
          set({ usageStats: response.data, isLoadingUsage: false });
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to fetch usage stats',
            isLoadingUsage: false,
          });
          throw error;
        }
      },

      fetchKeyUsageStats: async (appId: string, keyId: string, period: string = '7d') => {
        set({ isLoadingUsage: true, error: null });
        try {
          const response = await apiClient.get(`/developer/apps/${appId}/keys/${keyId}/usage?period=${period}`);
          set({ usageStats: response.data, isLoadingUsage: false });
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to fetch key usage stats',
            isLoadingUsage: false,
          });
          throw error;
        }
      },

      fetchDeveloperStats: async () => {
        set({ isLoadingStats: true, error: null });
        try {
          const response = await apiClient.get('/developer/stats');
          set({ developerStats: response.data, isLoadingStats: false });
        } catch (error: any) {
          set({
            error: error.response?.data?.error || 'Failed to fetch developer stats',
            isLoadingStats: false,
          });
          throw error;
        }
      },

      // Utility actions
      clearError: () => set({ error: null }),

      reset: () =>
        set({
          apps: [],
          currentApp: null,
          apiKeys: [],
          usageStats: null,
          developerStats: null,
          error: null,
        }),
    }),
    {
      name: 'developer-storage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        // Only persist apps and currentApp, not stats or loading states
        apps: state.apps,
        currentApp: state.currentApp,
      }),
    }
  )
);
