import { useQueryClient } from '@tanstack/react-query';
import { useGemieRealtime, useRealtimeEvent, useRealtimeReset } from '@gemies/sdk/runtime';
import type { RealtimeData } from '@gemies/sdk/realtime';
import { useEffect } from 'react';
import type { CreditsInfo } from '@/features/billing/runtime/use-credits';
import { queryKeys } from '@/shared/api/query-keys';

/** The local runtimes list's key (`use-local-runtimes`). */
const LOCAL_RUNTIMES_KEY = ['local-runtimes'] as const;

/**
 * What the app keeps live from the account's realtime connection (Gemies `docs/realtime.mdx`) —
 * the lists that are the app's own. The conversations, their messages, reactions, rooms and
 * "typing…" are the SDK's and stay live by themselves. Mounted once, inside the runtime provider.
 * Nothing here polls: each event patches what it carries, and re-reads at most the one list it
 * names.
 */
export function useAppRealtime(): void {
  const queryClient = useQueryClient();

  // The balance, as the server settled it, on every device. The query is keyed by account and
  // session under `credits.info`: every one of them is this account's.
  useRealtimeEvent('credits', (frame) => {
    const { credits } = frame.data as RealtimeData['credits'];
    if (typeof credits === 'number') {
      queryClient.setQueriesData<CreditsInfo>({ queryKey: queryKeys.credits.info }, (old) =>
        old ? { ...old, credits } : old,
      );
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });
  });

  useRealtimeEvent('notification', () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  });

  // A device offering its own model joined or left.
  useRealtimeEvent('runtimes', () => {
    void queryClient.invalidateQueries({ queryKey: LOCAL_RUNTIMES_KEY, exact: true });
  });

  // Back after a disconnection: the `runtimes` signals of the time away are not replayed.
  const realtime = useGemieRealtime();
  useEffect(() => {
    if (!realtime) return;
    let wasDown = false;
    return realtime.onStatus((connected) => {
      if (!connected) {
        wasDown = true;
        return;
      }
      if (!wasDown) return;
      wasDown = false;
      void queryClient.invalidateQueries({ queryKey: LOCAL_RUNTIMES_KEY, exact: true });
    });
  }, [realtime, queryClient]);

  // Too far behind to catch up: read the app's own lists again, once.
  useRealtimeReset(() => {
    for (const queryKey of [queryKeys.credits.info, ['notifications'], LOCAL_RUNTIMES_KEY]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });
}
