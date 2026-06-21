import { useEffect } from 'react';
import { useAuth } from '@oxyhq/services';
import { useUserDataStore } from '@/lib/stores/user-data-store';
import apiClient from '@/lib/api/client';

export function useUserData() {
  const { isAuthenticated } = useAuth();
  const { memory, loading, setMemory, setLoading, shouldRefetch, clearMemory } = useUserDataStore();

  useEffect(() => {
    // Clear data if not authenticated
    if (!isAuthenticated) {
      clearMemory();
      return;
    }

    // Only fetch if we should refetch (cache expired or no data)
    if (!shouldRefetch() && memory) {
      return;
    }

    const fetchUserData = async () => {
      setLoading(true);
      try {
        const response = await apiClient.get('/memory');
        if (response.data) {
          setMemory(response.data);
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchUserData();
  }, [isAuthenticated, shouldRefetch]);

  return {
    memory,
    loading,
    refetch: () => {
      clearMemory();
      // This will trigger the useEffect to fetch again
    },
  };
}
