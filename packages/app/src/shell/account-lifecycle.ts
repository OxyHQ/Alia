import { ALIA_ACCOUNT_QUERIES } from '@/shared/api/query-keys';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useInsertionEffect, useLayoutEffect, useRef } from 'react';
import { queryKeys as oxyQueryKeys } from '@oxy.so/services/ui/client';
import { useConversationStore, useThoughtStore } from '@gemies/sdk/runtime';
import { useStore } from '@/features/chat/runtime/global-store';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useLibraryStore } from '@/features/library/runtime/library-store';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import { useShowStore } from '@/features/shows/runtime/show-store';
import {
  advanceAccountEpoch,
  bindAccountProjectionShell,
  commitAccountProjection,
  releaseAccountProjectionShell,
} from '@/shared/state/account-epoch';

/**
 * What happens to the previous account's in-memory state when the signed-in
 * account changes: a sign-out, or a switch to another account (#608 §4).
 *
 * Oxy removes and restores its declared account queries before publishing the new account.
 * Alia resets its in-memory stores and only the queries outside that ownership policy.
 * Resetting Oxy-owned queries here races restoration and erases the new account's cache.
 * The epoch also advances so outstanding store reads cannot publish the old account.
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
      rightPanelWidth: ui.rightPanelWidth,
    },
    true,
  );
  useStore.setState(useStore.getInitialState(), true);
  // The thought panel carries a conversation's messages.
  useThoughtStore.setState(useThoughtStore.getInitialState(), true);
  // The first message queued for a conversation that was just created, and which row streams.
  useConversationStore.setState(useConversationStore.getInitialState(), true);
  useUserDataStore.setState(useUserDataStore.getInitialState(), true);
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useShowStore.setState({ ...useShowStore.getInitialState(), activeGenerations: new Map() }, true);

  // Oxy owns the declared roots; this reset only covers the remaining product queries.
  if (next !== null) {
    const filters = { predicate: isAliaQuery };
    void queryClient.cancelQueries(filters).then(() => queryClient.resetQueries(filters));
  }
}

const OXY_QUERY_HEADS = new Set([
  ...ALIA_ACCOUNT_QUERIES.roots,
  ...Object.values(oxyQueryKeys).flatMap((group) => {
    const all = (group as { all?: readonly unknown[] }).all;
    return Array.isArray(all) && typeof all[0] === 'string' ? [all[0]] : [];
  }),
]);

/** Queries whose account lifecycle is not already managed by Oxy. */
function isAliaQuery(query: { queryKey: readonly unknown[] }): boolean {
  const head = query.queryKey[0];
  return !(typeof head === 'string' && OXY_QUERY_HEADS.has(head));
}

/**
 * Runs {@link resetAccountSession} when the signed-in account moves on from
 * one that was signed in — never on the first sign-in from signed-out.
 * Mounted once, by the app layout, next to the account-scoped store bindings.
 */
export function useAccountLifecycle(userId: string | null, sessionId: string | null = null): void {
  const shell = useRef({});
  useInsertionEffect(() => {
    const lease = shell.current;
    bindAccountProjectionShell(lease);
    return () => releaseAccountProjectionShell(lease);
  }, []);
  useLayoutEffect(() => {
    commitAccountProjection(userId, sessionId);
  }, [userId, sessionId]);
  const queryClient = useQueryClient();
  const previous = useRef(userId);
  useEffect(() => {
    const was = previous.current;
    previous.current = userId;
    if (was === null || was === userId) return;
    resetAccountSession(queryClient, userId);
  }, [userId, queryClient]);
}
