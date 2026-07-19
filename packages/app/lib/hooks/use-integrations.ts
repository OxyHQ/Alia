import { useState, useEffect, useCallback } from 'react';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

export interface IntegrationEntry {
  service: string;
  name: string;
  icon: string;
  description: string;
  category: string;
}

export interface ConnectedIntegration {
  _id: string;
  service: string;
  displayName: string;
  accountId?: string;
  accountName?: string;
  avatarUrl?: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
  enabled: boolean;
  connectedAt: string;
  lastUsedAt?: string;
}

export function useIntegrations() {
  const { isAuthenticated } = useOxy();
  const [available, setAvailable] = useState<IntegrationEntry[]>([]);
  const [connected, setConnected] = useState<ConnectedIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchAll = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    try {
      const [availableRes, connectedRes] = await Promise.all([
        apiClient.get('/integrations/available'),
        apiClient.get('/integrations'),
      ]);
      setAvailable(
        (availableRes.data.integrations || []).filter(
          (i: IntegrationEntry & { configured?: boolean }) => i.configured !== false,
        ),
      );
      setConnected(connectedRes.data.integrations || []);
      setError(null);
    } catch (err: unknown) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const getOAuthUrl = async (service: string): Promise<string> => {
    const response = await apiClient.get(`/integrations/${service}/oauth-url`);
    return response.data.authUrl;
  };

  // Finalize the OAuth link once the browser returns to the app with the
  // state + code delivered by the (now non-linking) callback. Authenticated,
  // so the Integration binds to this session — see integrations-oauth.ts.
  const completeOAuth = async (service: string, state: string, code: string): Promise<void> => {
    await apiClient.post(`/integrations/${service}/complete`, { state, code });
    await fetchAll();
  };

  const disconnect = async (integrationId: string) => {
    await apiClient.delete(`/integrations/${integrationId}`);
    await fetchAll();
  };

  return {
    available,
    connected,
    loading,
    error,
    getOAuthUrl,
    completeOAuth,
    disconnect,
    refresh: fetchAll,
  };
}
