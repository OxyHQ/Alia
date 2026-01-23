import { useState, useEffect } from 'react';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

interface TelegramStatus {
  linked: boolean;
  telegramUsername?: string;
  linkedAt?: Date;
}

export function useTelegramStatus() {
  const { isAuthenticated, activeSessionId } = useOxy();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchStatus() {
      if (!isAuthenticated || !activeSessionId) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const response = await apiClient.get('/telegram/link-status');
        setStatus(response.data);
        setError(null);
      } catch (err) {
        console.error('Failed to fetch Telegram status:', err);
        setError(err as Error);
        setStatus({ linked: false }); // Safe default
      } finally {
        setLoading(false);
      }
    }

    fetchStatus();
  }, [isAuthenticated, activeSessionId]);

  const refresh = async () => {
    if (!isAuthenticated || !activeSessionId) return;

    try {
      setLoading(true);
      const response = await apiClient.get('/telegram/link-status');
      setStatus(response.data);
      setError(null);
    } catch (err) {
      console.error('Failed to refresh Telegram status:', err);
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  };

  return { status, loading, error, refresh };
}
