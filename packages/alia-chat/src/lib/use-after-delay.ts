import { useEffect, useState } from 'react';

/**
 * `active`, but only once it has held for `delay` ms; false again the moment it stops. For an
 * indicator that must not flash for a state that ends at once (Alia "thinking" for the instant
 * before she hands the turn to an agent, where the agent is the one that thinks).
 */
export function useAfterDelay(active: boolean, delay: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!active) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return settled;
}
