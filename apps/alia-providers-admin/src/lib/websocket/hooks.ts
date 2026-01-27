/**
 * React hooks for real-time data subscriptions
 */

import { useEffect, useState, useCallback } from 'react';
import { realtimeClient } from './client';

/**
 * Hook to track WebSocket connection status
 */
export function useConnectionStatus() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'reconnecting' | 'connecting'>(
    realtimeClient.getStatus()
  );

  useEffect(() => {
    const unsubscribe = realtimeClient.onConnectionChange(setStatus);
    return unsubscribe;
  }, []);

  return status;
}

/**
 * Generic hook for subscribing to real-time data
 */
export function useRealtimeData<T>(channel: string, initialData?: T) {
  const [data, setData] = useState<T | undefined>(initialData);
  const [isConnected, setIsConnected] = useState(realtimeClient.getStatus() === 'connected');

  useEffect(() => {
    // Subscribe to connection changes
    const unsubscribeConnection = realtimeClient.onConnectionChange((status) => {
      setIsConnected(status === 'connected');
    });

    // Subscribe to data updates
    const unsubscribeData = realtimeClient.subscribe(channel, (newData) => {
      setData(newData as T);
    });

    return () => {
      unsubscribeConnection();
      unsubscribeData();
    };
  }, [channel]);

  return { data, isConnected };
}

/**
 * Hook for real-time provider health data
 */
export function useRealtimeHealth(provider?: string, modelId?: string) {
  const channel = provider && modelId
    ? `health:${provider}:${modelId}`
    : provider
    ? `health:${provider}`
    : 'health:all';

  return useRealtimeData(channel);
}

/**
 * Hook for real-time keys data
 */
export function useRealtimeKeys(filters?: { provider?: string; environment?: string; active?: boolean }) {
  const channel = filters?.provider
    ? `keys:${filters.provider}`
    : 'keys:all';

  return useRealtimeData(channel);
}

/**
 * Hook for real-time models data
 */
export function useRealtimeModels(filters?: { provider?: string; aliaTier?: string; active?: boolean }) {
  const channel = filters?.provider
    ? `models:${filters.provider}`
    : 'models:all';

  return useRealtimeData(channel);
}

/**
 * Hook to send real-time messages
 */
export function useRealtimeSend() {
  const send = useCallback((message: unknown) => {
    realtimeClient.send(message);
  }, []);

  return send;
}

/**
 * Hook to manually trigger reconnection
 */
export function useRealtimeReconnect() {
  const reconnect = useCallback(() => {
    realtimeClient.disconnect();
    realtimeClient.connect();
  }, []);

  return reconnect;
}
