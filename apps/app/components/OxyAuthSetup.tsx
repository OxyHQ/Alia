import { useEffect, useRef } from 'react';
import { useOxy } from '@oxyhq/services';
import { setSessionGetter } from '@/lib/api/client';

/**
 * Component that connects Oxy authentication to the API client.
 * Must be rendered inside OxyProvider.
 */
export function OxyAuthSetup({ children }: { children: React.ReactNode }) {
  const { activeSessionId, isAuthenticated } = useOxy();

  // Use ref to store session ID to avoid stale closures in interceptor
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    sessionIdRef.current = isAuthenticated ? activeSessionId : null;
  }, [activeSessionId, isAuthenticated]);

  useEffect(() => {
    // Set up the session getter for the API client
    // This allows API calls to include the Oxy session ID
    setSessionGetter(() => sessionIdRef.current);
  }, []);

  return <>{children}</>;
}
