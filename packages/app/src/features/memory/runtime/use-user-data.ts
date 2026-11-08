import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import apiClient from '@/shared/api/client';
import { currentAccountEpoch, isCurrentAccountEpoch } from '@/shared/state/account-epoch';

export const USER_MEMORY_QUERY_KEY = ['user-memory'] as const;

/**
 * React Query owns when to read; the zustand store stays the shared read surface
 * the rest of the app subscribes to, so the query function writes through to it.
 */
export function useUserData() {
  const { isAuthenticated } = useAuth();
  const stored = useUserDataStore((s) => s.memory);
  // Signing out must not leave the previous account's profile on screen.
  const memory = isAuthenticated ? stored : null;

  const { isFetching, refetch } = useQuery({
    queryKey: USER_MEMORY_QUERY_KEY,
    enabled: isAuthenticated,
    // The profile can change from another surface, so a cached copy is stale
    // as soon as the app asks again.
    staleTime: 0,
    queryFn: async () => {
      const epoch = currentAccountEpoch();
      const response = await apiClient.get('/memory');
      // Asked for the account before a switch or a sign-out: not this one's.
      if (response.data && isCurrentAccountEpoch(epoch)) {
        useUserDataStore.getState().setMemory(response.data);
      }
      return response.data;
    },
  });

  // Only a cold read is "loading" — a background refresh must not blank a
  // screen that already has something to show.
  return { memory, loading: isFetching && !memory, refetch };
}
