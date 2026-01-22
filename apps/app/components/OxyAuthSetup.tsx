import { useEffect, useRef } from 'react';
import { useOxy } from '@oxyhq/services';
import { setSessionGetter } from '@/lib/api/client';

/**
 * Component that connects Oxy authentication to the API client.
 * Must be rendered inside OxyProvider.
 */
export function OxyAuthSetup({ children }: { children: React.ReactNode }) {
  const { activeSessionId, isAuthenticated } = useOxy();

  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    sessionIdRef.current = isAuthenticated ? activeSessionId : null;
  }, [activeSessionId, isAuthenticated]);

  useEffect(() => {
    setSessionGetter(() => sessionIdRef.current);
  }, []);

  return <>{children}</>;
}
