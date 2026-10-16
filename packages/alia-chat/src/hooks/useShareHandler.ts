import { toast } from '@oxy.so/bloom/toast';
import { useCallback } from 'react';
import { useLabels } from '../lib/labels';
import { type AliaConversationShare, useShareConversation } from '../runtime/sharing';

/**
 * What the header's share button does: mint the conversation's read-only link, then hand it to
 * the host, which builds its own URL and shows its own share sheet. `undefined` without a host
 * `onShare`, so there is no button.
 */
export function useShareHandler(
  onShare: ((share: AliaConversationShare) => void) | undefined,
): ((conversationId: string | undefined) => void) | undefined {
  const { share } = useShareConversation();
  const { t } = useLabels();
  const handle = useCallback(
    (conversationId: string | undefined) => {
      if (conversationId === undefined || onShare === undefined) return;
      void share(conversationId).then(onShare, () => toast.error(t('chat.shareFailed')));
    },
    [share, onShare, t],
  );
  return onShare === undefined ? undefined : handle;
}
