import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
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
 * Real-time autocomplete search (Google-style, debounced client-side)
 */
export function useSearchSuggestions(query: string) {
  return useQuery<Suggestion[]>({
    queryKey: queryKeys.suggestions.search(query),
    queryFn: async () => {
      const res = await apiClient.post(API_ROUTES.suggestions.search, { query, limit: 6 });
      return res.data.suggestions;
    },
    enabled: query.trim().length >= 2,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    retry: 0,
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
      queryClient.invalidateQueries({ queryKey: queryKeys.suggestions.me });
    },
  });
}

/**
 * Auto-generate personalized suggestions once per app session.
 * Call from the app layout so it fires as soon as auth is ready.
 */
export function useSessionSuggestionGeneration() {
  const { isAuthenticated } = useAuth();
  const { mutate } = useGenerateSuggestions();
  const hasGenerated = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || hasGenerated.current) return;
    hasGenerated.current = true;
    mutate({ count: 8, types: ['welcome', 'autocomplete'] });
  }, [isAuthenticated, mutate]);
}
