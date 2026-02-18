import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { queryKeys } from './query-keys';

export interface Suggestion {
  suggestionId: string;
  title: string;
  text: string;
  description?: string;
  isTemplate: boolean;
  templateVariables?: string[];
  type: 'welcome' | 'autocomplete';
  category?: string;
  triggerWords: string[];
  scope: 'global' | 'personal';
  language: string;
  usageCount: number;
  priority: number;
  isBuiltIn: boolean;
  isAIGenerated: boolean;
  tags: string[];
  expiresAt?: string;
}

/**
 * Fetch welcome card suggestions (POST, language resolved server-side)
 * Backend returns random/personalized suggestions from the pool.
 */
export function useWelcomeSuggestions() {
  return useQuery<Suggestion[]>({
    queryKey: queryKeys.suggestions.welcome,
    queryFn: async () => {
      const res = await apiClient.post(API_ROUTES.suggestions.welcome, { count: 4 });
      return res.data.suggestions;
    },
    staleTime: 1000 * 60 * 15, // 15 minutes
    retry: 1,
  });
}

/**
 * Fetch all autocomplete suggestions (cached locally for instant client-side search)
 */
export function useAutocompleteSuggestions() {
  return useQuery<Suggestion[]>({
    queryKey: queryKeys.suggestions.autocomplete,
    queryFn: async () => {
      const res = await apiClient.post(API_ROUTES.suggestions.list, { type: 'autocomplete', limit: 500 });
      return res.data.suggestions;
    },
    staleTime: 1000 * 60 * 30, // 30 minutes
    retry: 1,
  });
}

/**
 * Record suggestion usage (fire-and-forget mutation)
 */
export function useRecordSuggestionUsage() {
  return useMutation({
    mutationFn: async (suggestionId: string) => {
      await apiClient.post(API_ROUTES.suggestions.use(suggestionId), {});
    },
  });
}

/**
 * AI-generate personalized suggestions
 */
export function useGenerateSuggestions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params?: { count?: number; types?: string[] }) => {
      const res = await apiClient.post(API_ROUTES.suggestions.generate, params || {});
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.suggestions.welcome });
      queryClient.invalidateQueries({ queryKey: queryKeys.suggestions.autocomplete });
      queryClient.invalidateQueries({ queryKey: queryKeys.suggestions.me });
    },
  });
}
