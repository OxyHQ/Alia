import { useTranslation } from '@/shared/i18n/use-translation';
import { Notification } from '@oxy.so/bloom/notification';
import React from 'react';
interface NewConversationOfferProps {
  /**
   * The model's own sentence for why it is offering, in the model's own words,
   * or empty when it sent none.
   *
   * Never translated and never rewritten. A substitute we invented would read
   * as the agent's reasoning while being ours, and a plausible one is worse
   * than none — so an empty reason simply drops the line.
   */
  reason: string;
  onAccept: () => void;
  onDismiss: () => void;
}

/**
 * The agent offering to start the next stretch of the thread fresh.
 *
 * ## It is an offer, and the shape has to say so
 *
 * Nothing has been written when this appears: the tool behind it creates
 * nothing, so ignoring it leaves the thread exactly as it was. That is why this
 * is a card at the end of the list rather than a dialog — it does not cover
 * what somebody is reading, does not take focus from the composer, and carries
 * on being ignorable for as long as they ignore it.
 *
 * Accepting is the person's act: it starts a conversation with the same agent.
 * The agent cannot do that itself, by construction rather than by policy.
 *
 * Bloom's `Notification` with the two answers as its actions: "Not now" the
 * quiet one, "Start new conversation" the solid one.
 */
export const NewConversationOffer = React.memo(function NewConversationOffer({
  reason,
  onAccept,
  onDismiss,
}: NewConversationOfferProps) {
  const { t } = useTranslation();

  return (
    <Notification
      status="information"
      title={t('chat.newConversationOffer')}
      description={reason === '' ? undefined : reason}
      actions={[
        { label: t('chat.newConversationDismiss'), onPress: onDismiss },
        { label: t('chat.newConversationAccept'), onPress: onAccept },
      ]}
      dismissible={false}
    />
  );
});
