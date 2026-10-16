import { toast } from '@oxy.so/bloom/toast';
import { useCallback } from 'react';
import { type AliaChatLabels, useLabels } from '../lib/labels';
import type { AliaAttachment } from '../types';
import { buildMessageContent, type DroppedAttachment } from './attachment-utils';
import { useDocumentUpload } from './oxy-files';
import { useComposerDraftStore, type DraftTarget } from './composer-draft-store';
import { useAliaRuntime } from './config';
import { useConversationStore } from './conversation-store';
import { useCreateConversation } from './conversations';
import type { SendOptions } from './types';

/**
 * Say which attachments the turn went without.
 *
 * `buildMessageContent` used to drop them in silence: a document was filtered
 * out by `a.type === 'image'`, and an image whose bytes would not read was a
 * bare `continue`. The composer had already shown both as attached, so the
 * turn left with the person believing the file went with it — the visible
 * state and the real capability disagreeing, which is the failure #608 §1.6
 * names.
 *
 * A toast rather than a blocked send: the message itself is fine and worth
 * sending, and refusing the whole turn over a file the format cannot carry
 * would be a worse trade. What matters is that nobody finds out by noticing
 * the answer ignored their PDF.
 */
export function reportDroppedAttachments(
  dropped: DroppedAttachment[] | undefined,
  labels: Pick<AliaChatLabels, 'attachmentNotSent' | 'attachmentUnreadable'>,
): void {
  if (dropped === undefined || dropped.length === 0) return;

  for (const attachment of dropped) {
    toast.error(
      attachment.reason === 'unsupported'
        ? labels.attachmentNotSent(attachment.name)
        : labels.attachmentUnreadable(attachment.name),
    );
  }
}

export interface StartConversationOptions {
  attachments?: AliaAttachment[];
  options?: SendOptions;
  /**
   * The composer whose draft the message came from, to hand it back if the conversation cannot
   * be made. A new-chat screen is `null` (the default); a screen that asks outside a chat names
   * its own (`surface:automations`).
   */
  draft?: DraftTarget;
}

/**
 * Start a conversation with a first message.
 *
 * The conversation is created, the message is queued for THAT conversation, and the host is told
 * to show it (`openConversation`): the thread that opens sends the message, so the person lands
 * on the conversation being answered. If the conversation cannot be made the composer gets its
 * draft back. This is the one path for a new-chat screen, the sheet's first turn and a screen
 * that starts a chat from elsewhere (a scheduled task described in words).
 */
export function useStartConversation({ agentId }: { agentId?: string } = {}) {
  const labels = useLabels();
  const { host } = useAliaRuntime();
  const { mutateAsync: createConversation } = useCreateConversation();
  const upload = useDocumentUpload();

  return useCallback(
    async (
      text: string,
      { attachments = [], options, draft: target = null }: StartConversationOptions = {},
    ): Promise<boolean> => {
      if (!text.trim() && attachments.length === 0) return false;
      const draft = useComposerDraftStore.getState().address(target);

      // Attachments become multi-part content. The raw text and attachments ride along so a
      // failed send can restore them.
      const built =
        attachments.length > 0 ? await buildMessageContent(text, attachments, upload) : null;
      reportDroppedAttachments(built?.dropped, labels);
      try {
        const conversation = await createConversation({ agentId });
        useConversationStore.getState().setPendingInitialMessage({
          conversationId: conversation.id,
          content: built ? built.content : text,
          text,
          attachments,
          mcpServerId: options?.mcpServerId ?? null,
          skillNames: options?.skillNames ?? [],
        });
        host.openConversation?.(conversation.id);
        return true;
      } catch {
        // useCreateConversation.onError already shows the toast.
        useComposerDraftStore.getState().restore(draft, {
          text,
          attachments,
          mcpServerId: options?.mcpServerId ?? null,
          skillNames: options?.skillNames ?? [],
        });
        return false;
      }
    },
    [labels, host, createConversation, agentId, upload],
  );
}
