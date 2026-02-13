import { useState, useEffect, useRef, useCallback } from 'react';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

export interface GatewaySession {
  sessionId: string;
  status: 'disconnected' | 'qr-pending' | 'linking' | 'connected' | 'logged-out' | 'unlinked' | 'failed' | 'not-found';
  phoneNumber?: string;
  displayName?: string;
  lastQR?: string;
  lastConnected?: string;
}

type GatewayPlatform = 'whatsapp' | 'telegram-gateway' | 'signal-gateway';

export function useGatewaySessions(platform: GatewayPlatform, poll = false) {
  const { isAuthenticated } = useOxy();
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [activeQRSessionId, setActiveQRSessionId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connectEndpoint = platform === 'signal-gateway' ? 'link' : 'connect';

  const fetchSessions = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    try {
      const response = await apiClient.get(`/channels/${platform}/sessions`);
      setSessions(response.data.sessions || []);
      setError(null);
    } catch (err: any) {
      if (err.response?.status === 404 || err.response?.status === 503) {
        setSessions([]);
      } else {
        setError(err as Error);
        setSessions([]);
      }
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, platform]);

  // Keep a stable ref so polling doesn't re-trigger
  const fetchSessionsRef = useRef(fetchSessions);
  useEffect(() => {
    fetchSessionsRef.current = fetchSessions;
  }, [fetchSessions]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Poll for QR status changes when actively connecting
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if ((poll || activeQRSessionId) && isAuthenticated) {
      intervalRef.current = setInterval(() => fetchSessionsRef.current(), 3000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll, activeQRSessionId, isAuthenticated]);

  // Clear activeQRSessionId when session connects
  useEffect(() => {
    if (activeQRSessionId) {
      const session = sessions.find(s => s.sessionId === activeQRSessionId);
      if (session?.status === 'connected') {
        setActiveQRSessionId(null);
      }
    }
  }, [sessions, activeQRSessionId]);

  const connectNew = async (): Promise<{ sessionId: string; qr?: string }> => {
    const response = await apiClient.post(`/channels/${platform}/session/${connectEndpoint}`);
    const data = response.data;
    setActiveQRSessionId(data.sessionId);
    await fetchSessions();
    return data;
  };

  const disconnect = async (sessionId: string) => {
    const endpoint = platform === 'signal-gateway' ? 'unlink' : 'disconnect';
    await apiClient.post(`/channels/${platform}/session/${sessionId}/${endpoint}`);
    setActiveQRSessionId(null);
    await fetchSessions();
  };

  const getQR = async (sessionId: string): Promise<string | null> => {
    try {
      const response = await apiClient.get(`/channels/${platform}/session/${sessionId}/qr`);
      return response.data.qr || response.data.lastQR || null;
    } catch {
      return null;
    }
  };

  const stopPolling = () => {
    setActiveQRSessionId(null);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const connectedCount = sessions.filter(s => s.status === 'connected').length;

  return {
    sessions,
    connectedCount,
    loading,
    error,
    activeQRSessionId,
    connectNew,
    disconnect,
    getQR,
    refresh: fetchSessions,
    stopPolling,
  };
}
