/**
 * WebSocket Provider Component
 * Initializes and manages WebSocket connection for the entire app
 */

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useAuth } from '@oxyhq/auth';
import { realtimeClient } from './client';

interface RealtimeContextValue {
  client: typeof realtimeClient;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

interface RealtimeProviderProps {
  children: ReactNode;
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  const { isAuthenticated, oxyServices } = useAuth();

  useEffect(() => {
    // Set token getter so WebSocket can authenticate with JWT access token
    realtimeClient.setTokenGetter(() => oxyServices.getAccessToken() || null);
  }, [oxyServices]);

  useEffect(() => {
    if (isAuthenticated) {
      realtimeClient.connect();
    } else {
      realtimeClient.disconnect();
    }

    return () => {
      realtimeClient.disconnect();
    };
  }, [isAuthenticated]);

  const value: RealtimeContextValue = {
    client: realtimeClient,
  };

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error('useRealtime must be used within RealtimeProvider');
  }
  return context;
}
