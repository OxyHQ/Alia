import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';

/** Authenticated GET query — wraps the repeated useOxy + useQuery pattern. */
export function useAuthQuery<T>(
  queryKey: readonly unknown[],
  url: string,
  params?: Record<string, any>,
  options?: Partial<UseQueryOptions<T>>,
) {
  const { isAuthenticated } = useOxy();
  return useQuery<T>({
    queryKey,
    queryFn: async () => {
      const res = await apiClient.get(url, params ? { params } : undefined);
      return res.data;
    },
    staleTime: 1000 * 60 * 5,
    retry: 2,
    enabled: isAuthenticated,
    ...options,
  });
}
