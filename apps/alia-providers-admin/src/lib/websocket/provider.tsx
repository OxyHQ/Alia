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
  const { isAuthenticated, activeSessionId } = useAuth();

  useEffect(() => {
    // Set token getter so WebSocket can authenticate — send session ID, not JWT
    // The server validates sessions via oxyClient.validateSession(sessionId)
    realtimeClient.setTokenGetter(() => activeSessionId || null);
  }, [activeSessionId]);

  useEffect(() => {
    if (isAuthenticated && activeSessionId) {
      realtimeClient.connect();
    } else {
      realtimeClient.disconnect();
    }

    return () => {
      realtimeClient.disconnect();
    };
  }, [isAuthenticated, activeSessionId]);

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
