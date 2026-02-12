import { useState, useEffect, useRef, useCallback } from 'react';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

interface WhatsAppStatus {
  status: 'disconnected' | 'qr-pending' | 'connected' | 'logged-out' | 'not-found';
  phoneNumber?: string;
  displayName?: string;
  lastQR?: string;
}

export function useWhatsAppStatus(poll = false) {
  const { isAuthenticated } = useOxy();
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    try {
      const response = await apiClient.get('/channels/whatsapp/session/status');
      setStatus(response.data);
      setError(null);
    } catch (err: any) {
      if (err.response?.status === 404 || err.response?.status === 503) {
        setStatus({ status: 'not-found' });
      } else {
        setError(err as Error);
        setStatus({ status: 'disconnected' });
      }
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Polling for QR code / connection status
  useEffect(() => {
    if (poll && isAuthenticated) {
      intervalRef.current = setInterval(fetchStatus, 3000);
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll, isAuthenticated, fetchStatus]);

  const connect = async () => {
    try {
      setLoading(true);
      const response = await apiClient.post('/channels/whatsapp/session/connect');
      setStatus(response.data);
      return response.data;
    } catch (err: any) {
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const disconnect = async () => {
    try {
      setLoading(true);
      await apiClient.post('/channels/whatsapp/session/disconnect');
      setStatus({ status: 'disconnected' });
    } catch (err: any) {
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const stopPolling = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  return { status, loading, error, refresh: fetchStatus, connect, disconnect, stopPolling };
}
