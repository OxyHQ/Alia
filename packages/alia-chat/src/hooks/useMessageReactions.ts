import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useRef, useState } from 'react';
import { useLabels } from '../lib/labels';
import { useAliaApi } from '../runtime/api';
import { ALIA_API_ROUTES } from '../runtime/model';

const NONE: readonly string[] = [];

/**
 * The emoji the person has left on this screen's messages, and the tap that leaves or takes one.
 *
 * What the server holds arrives with the message (`Message.reactions`); a tap shows at once and the
 * server's answer (the reactions the message holds now, which also applies its own limit) replaces
 * it. A failed tap goes back to what was there. `conversationId` is the conversation that holds the
 * MESSAGE, which is not always the one on screen, and is `undefined` for a message no conversation
 * holds yet (`Message.unsaved`): there is nothing to record the reaction on, and the press says so.
 */
export function useMessageReactions() {
  const { t } = useLabels();
  const api = useAliaApi();
  /** The reactions this screen has changed, by message id; the rest are the message's own. */
  const [held, setHeld] = useState<Readonly<Record<string, readonly string[]>>>({});
  const inFlight = useRef<Set<string>>(new Set());

  const reactionsOf = useCallback(
    (messageId: string, stored?: readonly string[]): readonly string[] =>
      held[messageId] ?? stored ?? NONE,
    [held],
  );

  const toggle = useCallback(
    (
      messageId: string,
      emoji: string,
      stored: readonly string[] | undefined,
      conversationId: string | undefined,
    ) => {
      if (conversationId === undefined) {
        toast.error(t('chat.reactionFailed'));
        return;
      }
      if (inFlight.current.has(messageId)) return;
      const before = held[messageId] ?? stored ?? NONE;
      const optimistic = before.includes(emoji)
        ? before.filter((held) => held !== emoji)
        : [...before, emoji];
      setHeld((current) => ({ ...current, [messageId]: optimistic }));
      inFlight.current.add(messageId);
      api
        .post<{ reactions: string[] }>(
          ALIA_API_ROUTES.conversations.react(conversationId, messageId),
          {
            emoji,
          },
        )
        .then(({ data }) => setHeld((current) => ({ ...current, [messageId]: data.reactions })))
        .catch(() => {
          setHeld((current) => ({ ...current, [messageId]: before }));
          toast.error(t('chat.reactionFailed'));
        })
        .finally(() => inFlight.current.delete(messageId));
    },
    [api, held, t],
  );

  return { reactionsOf, toggle };
}
