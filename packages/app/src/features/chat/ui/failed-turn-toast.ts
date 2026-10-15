import { useTranslation } from '@/shared/i18n/use-translation';
import { type FailedTurn } from '@alia.onl/sdk/model';
import { toast } from '@oxy.so/bloom/toast';
import { useEffect, useRef } from 'react';

/** One toast for the failed turn, replaced by the next failure and dismissed with the turn. */
export const FAILED_TURN_TOAST_ID = 'failed-turn';
/** Long enough to read the line and press Retry; a toast that is gone before that is no error. */
export const FAILED_TURN_TOAST_MS = 10_000;

/**
 * A failed turn is told with a toast, with Retry as its action.
 *
 * The person's message is still in the thread, and the toast says why it has no answer in the
 * app's own words, in the reader's language (the server's stand-in text, "all models are busy…",
 * is never shown as Alia's own). Real output before the failure reads "interrupted", not "couldn't
 * answer". The server's words, if any, go under the line. It leaves with the turn: when the failure
 * is cleared (a retry, a new message, another chat), so does the toast.
 */
export function useFailedTurnToast(
  failedTurn: FailedTurn | null | undefined,
  onRetry?: () => void,
) {
  const { t } = useTranslation();
  // The latest retry, without making a new toast of every render.
  const retry = useRef(onRetry);
  retry.current = onRetry;

  useEffect(() => {
    if (!failedTurn) return;
    const line = failedTurn.partial ? t('chat.turnInterrupted') : t('chat.turnFailed');
    const canRetry = failedTurn.retryable && retry.current !== undefined;
    toast.error(canRetry ? `${line} ${t('chat.turnFailedRetryHint')}` : line, {
      id: FAILED_TURN_TOAST_ID,
      description: failedTurn.detail || undefined,
      duration: FAILED_TURN_TOAST_MS,
      ...(canRetry ? { action: { label: t('chat.retry'), onClick: () => retry.current?.() } } : {}),
    });
    return () => {
      toast.dismiss(FAILED_TURN_TOAST_ID);
    };
  }, [failedTurn, t]);
}
