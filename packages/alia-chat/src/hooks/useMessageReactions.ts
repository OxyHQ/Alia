import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useLabels } from '../lib/labels';
import { useAliaApi } from '../runtime/api';
import { useAliaRuntime } from '../runtime/config';
import { ALIA_API_ROUTES } from '../runtime/model';
import {
  MessageReactionController,
  readMessageReactionUpdate,
  readMessageReactionAcknowledgement,
  type MessageReactionSnapshot,
} from '../runtime/message-reactions';
import { updateReactionCaches } from '../runtime/reaction-cache';

const NONE: readonly string[] = [];

/** Save a reaction's desired state; only pending intent overrides the latest server revision. */
export function useMessageReactions({
  conversationIds = [],
  onChange,
  enabled = true,
}: {
  conversationIds?: readonly string[];
  onChange?: (update: MessageReactionSnapshot) => void;
  enabled?: boolean;
} = {}) {
  const { t } = useLabels();
  const api = useAliaApi();
  const { host } = useAliaRuntime();
  const { user } = useOxy();
  const queryClient = useQueryClient();
  const [version, changed] = useReducer((value: number) => value + 1, 0);
  const callbacks = useRef({ onChange, t });
  callbacks.current = { onChange, t };
  const accountId = user?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: account identity scopes pending reactions
  const controller = useMemo(
    () =>
      new MessageReactionController({
        send: async ({ conversationId, messageId, emoji, active, mutationId }) => {
          const { data } = await api.post<Record<string, unknown>>(
            ALIA_API_ROUTES.conversations.react(conversationId, messageId),
            { emoji, active, mutationId },
          );
          const update = readMessageReactionAcknowledgement(
            data,
            conversationId,
            messageId,
            mutationId,
          );
          if (!update) throw new Error('Invalid reaction acknowledgement');
          return update;
        },
        changed,
        confirmed: (update) => {
          updateReactionCaches(queryClient, update);
          callbacks.current.onChange?.(update);
        },
        failed: () => toast.error(callbacks.current.t('chat.reactionFailed')),
      }),
    [api, queryClient, accountId],
  );

  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);

  const subscriptions = JSON.stringify([...new Set(conversationIds)].sort());
  const subscribe = host.subscribeConversationReactions;
  useEffect(() => {
    if (!enabled || !subscribe) return;
    const ids: string[] = JSON.parse(subscriptions);
    const unsubscribers = ids.map((conversationId) =>
      subscribe(conversationId, (value) => {
        const update = readMessageReactionUpdate(value);
        if (update?.conversationId === conversationId) controller.receive(update);
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [controller, enabled, subscribe, subscriptions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each update refreshes memoized rows
  const reactionsOf = useCallback(
    (
      messageId: string,
      stored: readonly string[] = NONE,
      conversationId?: string,
      revision = 0,
    ): readonly string[] =>
      conversationId === undefined
        ? stored
        : controller.reactionsOf(conversationId, messageId, stored, revision),
    [controller, version],
  );

  const toggle = useCallback(
    (
      messageId: string,
      emoji: string,
      stored: readonly string[] | undefined,
      conversationId: string | undefined,
      revision = 0,
    ) => {
      if (!enabled) return;
      if (conversationId === undefined) {
        toast.error(callbacks.current.t('chat.reactionFailed'));
        return;
      }
      controller.toggle(conversationId, messageId, emoji, stored ?? NONE, revision);
    },
    [controller, enabled],
  );
  return { reactionsOf, toggle, viewerId: accountId };
}
