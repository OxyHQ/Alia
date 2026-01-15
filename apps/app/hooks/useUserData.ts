import { useEffect } from 'react';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useUserDataStore } from '@/lib/stores/user-data-store';
import { generateAPIUrl } from '@/lib/generate-api-url';

export function useUserData() {
  const token = useAuthStore((state) => state.token);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const { memory, loading, setMemory, setLoading, shouldRefetch, clearMemory } = useUserDataStore();

  useEffect(() => {
    // Clear data if not authenticated
    if (!isAuthenticated || !token) {
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
        const apiUrl = generateAPIUrl('/api/memory');
        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          setMemory(data);
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchUserData();
  }, [token, isAuthenticated, shouldRefetch]);

  return {
    memory,
    loading,
    refetch: () => {
      clearMemory();
      // This will trigger the useEffect to fetch again
    },
  };
}
