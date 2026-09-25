import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { queryKeys as oxyQueryKeys } from '@oxy.so/services';
import { useStore } from '@/features/chat/runtime/global-store';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useLibraryStore } from '@/features/library/runtime/library-store';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import { useShowStore } from '@/features/shows/runtime/show-store';
import { advanceAccountEpoch } from '@/shared/state/account-epoch';

/**
 * What happens to the previous account's in-memory state when the signed-in
 * account changes: a sign-out, or a switch to another account (#608 §4).
 *
 * Oxy owns the session and its query cache. On a sign-out it clears the whole
 * cache; on a switch it only INVALIDATES, which keeps the previous account's
 * answers on screen until each refetch lands — A's chats in B's sidebar, A's
 * memories in B's settings. Nor does Oxy know about Alia's own stores, which
 * are not queries at all. This is Alia's half:
 *
 *  - Every store that holds an account's data goes back to its initial state:
 *    the memory document, the library, the shows, the thought panel (it
 *    carries a conversation's messages), the canvas, the agent panel, and the
 *    first message queued for a conversation that was just created. The
 *    sidebar collapse and the panel width are the device's, and stay.
 *  - The epoch advances, so a read still in flight for the previous account
 *    discards its answer instead of writing it (`src/shared/state/account-epoch.ts`).
 *  - On a switch, Alia's queries are cancelled and reset — not invalidated —
 *    so each shows its loading state and refetches with the new bearer. Oxy's
 *    own queries are left to Oxy.
 *
 * Signing IN from signed-out is not a change of owner: nothing was cached for
 * nobody, and the draft somebody typed before signing in is theirs. The caller
 * skips it (`useAccountLifecycle`).
 */
export function resetAccountSession(queryClient: QueryClient, next: string | null): void {
  advanceAccountEpoch();

  const ui = useUIStore.getState();
  useUIStore.setState(
    {
      ...useUIStore.getInitialState(),
      sidebarOpen: ui.sidebarOpen,
      rightPanelWidth: ui.rightPanelWidth,
    },
    true,
  );
  useStore.setState(useStore.getInitialState(), true);
  useUserDataStore.setState(useUserDataStore.getInitialState(), true);
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useShowStore.setState({ ...useShowStore.getInitialState(), activeGenerations: new Map() }, true);

  // Signed out, Oxy has already cleared every query. Switched, it has only
  // marked them stale.
  if (next !== null) {
    const filters = { predicate: isAliaQuery };
    void queryClient.cancelQueries(filters).then(() => queryClient.resetQueries(filters));
  }
}

const OXY_QUERY_HEADS = new Set(
  Object.values(oxyQueryKeys).flatMap((group) => {
    const all = (group as { all?: readonly unknown[] }).all;
    return Array.isArray(all) && typeof all[0] === 'string' ? [all[0]] : [];
  }),
);

/** Any query but the ones Oxy's own hooks read (accounts, sessions, devices…). */
function isAliaQuery(query: { queryKey: readonly unknown[] }): boolean {
  const head = query.queryKey[0];
  return !(typeof head === 'string' && OXY_QUERY_HEADS.has(head));
}

/**
 * Runs {@link resetAccountSession} when the signed-in account moves on from
 * one that was signed in — never on the first sign-in from signed-out.
 * Mounted once, by the app layout, next to the account-scoped store bindings.
 */
export function useAccountLifecycle(userId: string | null): void {
  const queryClient = useQueryClient();
  const previous = useRef(userId);
  useEffect(() => {
    const was = previous.current;
    previous.current = userId;
    if (was === null || was === userId) return;
    resetAccountSession(queryClient, userId);
  }, [userId, queryClient]);
}
