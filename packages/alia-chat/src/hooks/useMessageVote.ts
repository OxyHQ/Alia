import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useRef } from 'react';
import { useLabels } from '../lib/labels';
import { useAliaApi } from '../runtime/api';
import { ALIA_API_ROUTES } from '../runtime/model';

export type Vote = 'up' | 'down';

/**
 * Like or dislike a reply; pressing the same vote again retracts it.
 *
 * `conversationId` is the conversation that holds the MESSAGE, which is not always the one on
 * screen — a thread shows several, and an old message's vote sent to the stretch being streamed
 * into would fail quietly. It is `undefined` for a message no conversation holds yet
 * (`Message.unsaved`): a turn that failed or was stopped. There is nothing to record the vote on,
 * and the button cannot be hidden on its own, so the press says so rather than thanking the person
 * for nothing.
 */
export function useMessageVote() {
  const { t } = useLabels();
  const api = useAliaApi();
  /** This screen's votes, read to decide whether a press casts or retracts one. */
  const votes = useRef<Record<string, Vote>>({});
  const inFlight = useRef<Set<string>>(new Set());

  return useCallback(
    (messageId: string, vote: Vote, conversationId: string | undefined) => {
      if (conversationId === undefined) {
        toast.error(t('chat.feedbackFailed'));
        return;
      }
      if (inFlight.current.has(messageId)) return;
      const next = votes.current[messageId] === vote ? null : vote;
      if (next) votes.current[messageId] = next;
      else delete votes.current[messageId];
      inFlight.current.add(messageId);
      api
        .patch(ALIA_API_ROUTES.conversations.vote(conversationId, messageId), { vote: next })
        .then(() => toast.success(t('chat.thanksFeedback')))
        .catch(() => {
          // Back to what the server holds, so the next press casts it again.
          if (next) delete votes.current[messageId];
          else votes.current[messageId] = vote;
          toast.error(t('chat.feedbackFailed'));
        })
        .finally(() => inFlight.current.delete(messageId));
    },
    [api, t],
  );
}
