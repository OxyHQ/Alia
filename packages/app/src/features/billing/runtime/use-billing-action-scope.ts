import { useCallback, useLayoutEffect, useRef } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';

/** A paid action's continuation belongs to the account/session that started it. */
export function useBillingActionScope() {
  const { user, activeSessionId, isAuthenticated } = useOxy();
  const scope = useRef({ active: false });
  useLayoutEffect(() => {
    const current = { active: !!user?.id && !!activeSessionId && isAuthenticated };
    scope.current = current;
    return () => {
      current.active = false;
    };
  }, [user?.id, activeSessionId, isAuthenticated]);
  return useCallback(() => {
    const current = scope.current;
    return () => current.active && scope.current === current;
  }, []);
}
