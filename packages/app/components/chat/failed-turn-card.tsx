import { useTranslation } from '@/lib/hooks/use-translation';
import { Notification } from '@oxy.so/bloom/notification';
import React from 'react';
interface FailedTurnCardProps {
  /** Real output arrived before the failure — the wording says "interrupted", not "couldn't answer". */
  partial: boolean;
  /** Whether a retry is offered at all. */
  retryable: boolean;
  /** The server's own words, if any, under the line. */
  detail?: string;
  onRetry?: () => void;
}

/**
 * The error a failed turn is drawn with, in the thread, under the turn.
 *
 * A card in the list rather than a toast, because the whole point is that it
 * STAYS: the person's message is still there above it, the reason it has no
 * answer is stated beside it, and the way to try again is a button on it —
 * for as long as they leave it, not for the four seconds a toast lasts.
 *
 * The server's stand-in text ("all models are busy…") is never shown here as
 * Alia's words; the copy is the app's own, in the reader's language.
 *
 * Bloom's `Notification`, not dismissible (the card is the turn's state, not a
 * message to clear), announced as an alert, with Retry as its one solid action.
 */
export const FailedTurnCard = React.memo(function FailedTurnCard({
  partial,
  retryable,
  detail,
  onRetry,
}: FailedTurnCardProps) {
  const { t } = useTranslation();
  const line = partial ? t('chat.turnInterrupted') : t('chat.turnFailed');
  const canRetry = retryable && onRetry !== undefined;

  return (
    <Notification
      status="error"
      role="alert"
      title={canRetry ? `${line} ${t('chat.turnFailedRetryHint')}` : line}
      description={detail === undefined || detail === '' ? undefined : detail}
      actions={
        canRetry
          ? [{ label: t('chat.retry'), onPress: onRetry, appearance: 'solid', tone: 'accent' }]
          : undefined
      }
      dismissible={false}
    />
  );
});
