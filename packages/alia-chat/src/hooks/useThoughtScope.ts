import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { aliaQueryKeys } from '../runtime/query-keys';
import { type ThoughtScope, useThoughtStore } from '../runtime/thought-store';
import type { FailedTurn } from '../runtime/turn-failure';
import type { Message } from '../runtime/types';

export interface UseThoughtScopeOptions {
  /** The conversation being streamed into, or `undefined` for a new chat. */
  conversationId: string | undefined;
  messages: Message[];
  conversationLoading: boolean;
  isLoading: boolean;
  failedTurn: FailedTurn | null;
}

/**
 * This conversation as the thought panel reads it: its messages, whether they are all here yet,
 * and the turn in flight — kept in the thought store.
 *
 * Keyed on the conversation and its messages, NOT on the panel being open. Syncing only while
 * the panel was open meant the first press on a tool row rendered against whatever the store held
 * before — another conversation's messages, or none — and found nothing by id. The store accepts
 * this only while the open selection belongs to the same conversation, so a new-chat screen
 * mounted underneath cannot blank a panel opened here.
 *
 * A load that failed is read off the query cache at the moment the memo recomputes: the load's
 * end is what flips `conversationLoading`, so the read is fresh exactly when it matters.
 */
export function useThoughtScope({
  conversationId,
  messages,
  conversationLoading,
  isLoading,
  failedTurn,
}: UseThoughtScopeOptions): ThoughtScope {
  const queryClient = useQueryClient();
  const sync = useThoughtStore((s) => s.sync);

  const scope = useMemo<ThoughtScope>(() => {
    const loadFailed =
      conversationId !== undefined &&
      queryClient.getQueryState(aliaQueryKeys.conversations.detail(conversationId))?.status ===
        'error';
    return {
      conversationId: conversationId ?? null,
      messages,
      status: conversationLoading ? 'loading' : loadFailed ? 'failed' : 'ready',
      isLoading,
      failedTurn,
    };
  }, [conversationId, messages, conversationLoading, isLoading, failedTurn, queryClient]);

  useEffect(() => {
    sync(scope);
  }, [scope, sync]);

  return scope;
}
