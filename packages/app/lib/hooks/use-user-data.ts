import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { useUserDataStore } from '@/lib/stores/user-data-store';
import apiClient from '@/lib/api/client';

export const USER_MEMORY_QUERY_KEY = ['user-memory'] as const;

/**
 * React Query owns when to read; the zustand store stays the shared read surface
 * the rest of the app subscribes to, so the query function writes through to it.
 */
export function useUserData() {
  const { isAuthenticated } = useAuth();
  const stored = useUserDataStore((s) => s.memory);
  // Signing out must not leave the previous account's memories on screen.
  const memory = isAuthenticated ? stored : null;

  const { isFetching, refetch } = useQuery({
    queryKey: USER_MEMORY_QUERY_KEY,
    enabled: isAuthenticated,
    // The document is written by the assistant mid-conversation, so a cached
    // copy is stale the moment anything else in the app talks to Alia.
    staleTime: 0,
    queryFn: async () => {
      const response = await apiClient.get('/memory');
      if (response.data) {
        useUserDataStore.getState().setMemory(response.data);
      }
      return response.data;
    },
  });

  // Only a cold read is "loading" — a background refresh (the chat just wrote a
  // memory and invalidated this query) must not blank a screen that already has
  // something to show.
  return { memory, loading: isFetching && !memory, refetch };
}
