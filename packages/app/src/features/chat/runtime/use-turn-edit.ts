import { useCallback, useRef } from 'react';
import { getTextFromContent } from '@alia.onl/sdk/content';
import type { Attachment } from '@/features/chat/runtime/global-store';
import type { Message } from '@/features/chat/runtime/use-conversations';
import type { SendOptions } from '@/features/chat/runtime/use-streaming-chat';
import {
  useComposerDraft,
  useComposerDraftStore,
  type DraftTarget,
} from '@/features/chat/runtime/composer-draft-store';

export interface TurnEditOptions {
  /** The composer the edit happens in: this chat's draft. */
  target: DraftTarget;
  messages: readonly Message[];
  /** The options a question was sent with, when this screen sent it. */
  turnOptionsOf?: (userMessageId: string) => SendOptions | undefined;
  /** Send the rewrite in place of the question (`useChatConversation.editMessage`). */
  onEditMessage?: (
    messageId: string,
    text: string,
    options?: SendOptions,
    attachments?: Attachment[],
  ) => Promise<boolean>;
}

/**
 * Rewriting a question already sent, in the composer (#608 §7).
 *
 * Before the template this was an "Editing message" strip over the input, with
 * the id in the screen's own `useState` — so leaving the chat and coming back
 * forgot the edit and the next send became a new turn. The edit lives in the
 * chat's draft now (`composer-draft-store.ts`), like the text it is made of:
 * per account and per conversation, and gone when the draft is.
 *
 * - `start` loads the question's words and the connector and skills it was sent
 *   with into the composer, keeping aside what the composer held. A question
 *   this screen did not send has no record of its options, so the composer's
 *   own choice stays.
 * - `cancel` gives the composer back what it held.
 * - `submit` sends the rewrite; a failure leaves the composer still editing,
 *   with the words back in it (the send path restores those).
 *
 * `editing` is the edit only while its question is still in the thread: a
 * conversation cleared, or cut back by another edit, takes it away, and the
 * composer goes back to writing a new turn.
 */
export function useTurnEdit({ target, messages, turnOptionsOf, onEditMessage }: TurnEditOptions) {
  const draftEdit = useComposerDraft(target).editing;
  const editing =
    draftEdit !== undefined && messages.some((m) => m.id === draftEdit.messageId)
      ? draftEdit
      : undefined;

  // Read through a ref: `start` is a prop of every row in the thread, and an
  // identity that changed per streamed token would re-render all of them.
  const latestMessages = useRef(messages);
  latestMessages.current = messages;

  const start = useCallback(
    (messageId: string) => {
      const message = latestMessages.current.find((m) => m.id === messageId);
      if (message === undefined) return;
      const store = useComposerDraftStore.getState();
      const current = store.drafts[target ?? ''];
      const sentWith = turnOptionsOf?.(messageId);
      store.startEdit(store.address(target), {
        messageId,
        text: getTextFromContent(message.content),
        mcpServerId: sentWith?.mcpServerId ?? current?.mcpServerId ?? null,
        skillNames: sentWith?.skillNames ?? current?.skillNames ?? [],
      });
    },
    [target, turnOptionsOf],
  );

  const cancel = useCallback(() => {
    const store = useComposerDraftStore.getState();
    store.cancelEdit(store.address(target));
  }, [target]);

  /** Send `text` in place of the question being edited. The caller has cleared the draft. */
  const submit = useCallback(
    async (text: string, options?: SendOptions, attachments?: Attachment[]): Promise<boolean> => {
      if (editing === undefined || onEditMessage === undefined) return false;
      const address = useComposerDraftStore.getState().address(target);
      const sent = await onEditMessage(editing.messageId, text, options, attachments);
      if (!sent) useComposerDraftStore.getState().restore(address, { editing });
      return sent;
    },
    [editing, onEditMessage, target],
  );

  return {
    editing: onEditMessage === undefined ? undefined : editing,
    start: onEditMessage === undefined ? undefined : start,
    cancel,
    submit,
  };
}
