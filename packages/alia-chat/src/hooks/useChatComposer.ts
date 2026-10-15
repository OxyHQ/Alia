import type { AvatarFlights } from '@oxy.so/bloom/avatar-flight';
import { useOxy } from '@oxy.so/services/ui/client';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { NativeSyntheticEvent, TextInput, TextInputKeyPressEventData } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { ALIA_TO_PROFILE } from '../lib/flights';
import { imageUriToDataUrl } from '../lib/image-data-url';
import {
  useComposerDraft,
  useComposerDraftStore,
  useDraftAddress,
} from '../runtime/composer-draft-store';
import type { SendOptions } from '../runtime/types';
import type { ConversationThread } from '../runtime/use-conversation-thread';
import { useTurnEdit } from '../runtime/use-turn-edit';
import type { AliaAttachment, AliaSuggestion } from '../types';
import { useComposerSuggestions, useSuggestionQuery } from './useComposerSuggestions';
import { useFocusWhenPresented } from './useFocusWhenPresented';

/** A turn of the person's: the text, and the photos (`data:` or `https:` URLs) sent with it. */
export interface AliaTurn {
  text: string;
  images?: ReadonlyArray<string>;
}

export interface UseChatComposerOptions {
  conversationId: string | undefined;
  thread: ConversationThread;
  /** Nothing is stored: the first turn is sent without creating a conversation (ghost mode). */
  ephemeral: boolean;
  /** The composer is closed (the usage limit): nothing may be sent. */
  closed: boolean;
  /** A write is done in the present, so it ends a jump into the thread's past. */
  onWrite: () => void;
  /**
   * Hands the first turn of an empty chat to the host instead of sending it here (a sheet opens
   * the conversation in a new sheet over this one).
   */
  onStart: ((turn: AliaTurn) => void) | undefined;
  /** The avatar flights: the greeting leaves with the first turn. */
  flights: AvatarFlights;
  /** A turn sent once as the chat mounts: the conversation a sheet was opened for. */
  initialTurn: AliaTurn | undefined;
  /** The signed-out person sent a turn: the host asks them to sign in. */
  onSignInRequired: (() => void) | undefined;
  /** A refusal to say, with its title. */
  reportError: (message: string, title?: string) => void;
  /** The suggestions over the composer on an empty chat, and the host's side of finding them. */
  welcomeSuggestions: AliaSuggestion[] | undefined;
  suggestionMatches: AliaSuggestion[] | undefined;
  onSuggestionQuery: ((query: string) => void) | undefined;
  onSuggestionPicked: ((suggestion: AliaSuggestion) => void) | undefined;
  /** The sheet this chat is in: the composer takes focus once it is up. */
  presentedProgress: SharedValue<number> | undefined;
}

/** A photo handed over as a `data:` URL, as the composer would hold it. */
function dataUrlAttachment(url: string, index: number): AliaAttachment {
  const mimeType = /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/jpeg';
  return {
    id: `turn-photo-${index}`,
    type: 'image',
    name: `photo-${index + 1}`,
    uri: url,
    size: 0,
    mimeType,
  };
}

/**
 * Everything the person does with the composer: the draft they are writing (kept per conversation,
 * shared with every other surface), sending it, rewriting a question already sent, answering
 * Alia's questions, picking a suggestion, asking for a reply again.
 *
 * Sending is the one path every turn takes. The draft is cleared at once and handed back if the
 * request fails; an edit replaces the question it rewrites; an empty chat may hand its first turn
 * to the host; a signed-out person is sent to sign in with their draft kept.
 */
export function useChatComposer({
  conversationId,
  thread,
  ephemeral,
  closed,
  onWrite,
  onStart,
  flights,
  initialTurn,
  onSignInRequired,
  reportError,
  welcomeSuggestions,
  suggestionMatches,
  onSuggestionQuery,
  onSuggestionPicked,
  presentedProgress,
}: UseChatComposerOptions) {
  const { isAuthenticated } = useOxy();
  const {
    messages,
    isLoading,
    sendMessage,
    createNewConversation,
    editMessage,
    regenerateMessage,
    turnOptionsOf,
  } = thread;

  // ── The draft ──
  const target = conversationId ?? null;
  const draft = useComposerDraft(target);
  const address = useDraftAddress(target);
  const photos = draft.attachments;
  /** What a send carries beyond the text: the connector and skills chosen for this turn. */
  const turnOptions = useMemo<SendOptions>(
    () => ({ mcpServerId: draft.mcpServerId, skillNames: draft.skillNames }),
    [draft.mcpServerId, draft.skillNames],
  );
  const setText = useCallback(
    (text: string) => useComposerDraftStore.getState().setText(address, text),
    [address],
  );
  const addAttachment = useCallback(
    (attachment: AliaAttachment) =>
      useComposerDraftStore.getState().addAttachment(address, attachment),
    [address],
  );
  const removeAttachment = useCallback(
    (id: string) => useComposerDraftStore.getState().removeAttachment(address, id),
    [address],
  );
  const edit = useTurnEdit({ target, messages, turnOptionsOf, onEditMessage: editMessage });
  const { editing } = edit;

  // ── Sending ──
  // A turn goes into the open conversation; with none open, it creates one and is sent from it —
  // unless nothing is to be stored.
  const sendTurn = useCallback(
    (text: string, attachments?: AliaAttachment[], options?: SendOptions) =>
      conversationId || ephemeral
        ? sendMessage(text, attachments, options)
        : createNewConversation(text, attachments, options),
    [conversationId, ephemeral, sendMessage, createNewConversation],
  );

  // The first turn of an empty chat goes to the host when it asked for it; every other turn is
  // sent here.
  const firstTurn = messages.length === 0;
  const startsElsewhere = onStart !== undefined && firstTurn;
  const submitTurn = useCallback(
    async (text: string, attachments: AliaAttachment[] = [], options?: SendOptions) => {
      onWrite();
      if (startsElsewhere) {
        const images = await Promise.all(
          attachments.map((photo) => imageUriToDataUrl(photo.uri, photo.mimeType)),
        );
        // The host's conversation sheet opens first so that the flight, drawn when it launches, is
        // above it; this chat stays on the greeting, so the avatar can still be measured.
        onStart({ text, ...(images.length > 0 ? { images } : {}) });
        await flights.launch([ALIA_TO_PROFILE]);
        return;
      }
      // The greeting leaves with the first turn: measure it before it does.
      if (firstTurn) await flights.launch([ALIA_TO_PROFILE]);
      await sendTurn(text, attachments, options);
    },
    [startsElsewhere, onStart, firstTurn, flights, sendTurn, onWrite],
  );

  // The conversation this chat was opened for, sent once.
  const initialSent = useRef(false);
  useEffect(() => {
    if (!initialTurn || initialSent.current) return;
    initialSent.current = true;
    void sendTurn(initialTurn.text, initialTurn.images?.map(dataUrlAttachment));
  }, [initialTurn, sendTurn]);

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      if ((!text && photos.length === 0) || isLoading || closed) return;
      // An edit rewrites the question's words; an attachment alone does not make a replacement.
      if (editing !== undefined && !text) return;
      // Signed out: the host asks for the sign-in instead of firing a request that would 401. The
      // draft stays in the composer for after.
      if (!isAuthenticated && onSignInRequired) {
        onSignInRequired();
        return;
      }
      const attachments = photos.length > 0 ? photos : undefined;
      // Cleared optimistically: the send path restores text, attachments and the turn's connector
      // and skills to this draft if the request fails.
      useComposerDraftStore.getState().clear(address);
      try {
        if (editing !== undefined) await edit.submit(text, turnOptions, attachments);
        else await submitTurn(text, attachments, turnOptions);
      } catch (err) {
        // Nothing was sent (the photos could not be read): keep the draft.
        useComposerDraftStore.getState().restore(address, { text: value, attachments: photos });
        reportError(err instanceof Error ? err.message : 'Could not attach the photos');
      }
    },
    [
      photos,
      isLoading,
      closed,
      editing,
      isAuthenticated,
      onSignInRequired,
      address,
      edit,
      turnOptions,
      submitTurn,
      reportError,
    ],
  );

  // A reply again, sent the way its question was (the composer's choice when it is unknown).
  const latest = useRef({ regenerateMessage, turnOptions });
  latest.current = { regenerateMessage, turnOptions };
  const regenerate = useCallback((assistantMessageId: string) => {
    const { regenerateMessage: again, turnOptions: fallback } = latest.current;
    void again(assistantMessageId, fallback);
  }, []);

  // ── Suggestions over the composer on an empty chat ──
  const query = useSuggestionQuery(draft.text, firstTurn && !closed);
  useEffect(() => {
    onSuggestionQuery?.(query);
  }, [query, onSuggestionQuery]);
  // Read through a ref: it is a prop of the suggestions' rows and the send path changes per token.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  const pickSuggestion = useCallback(
    (suggestion: AliaSuggestion) => {
      onSuggestionPicked?.(suggestion);
      // A template has blanks to fill, so it goes into the composer for the person to finish
      // instead of being sent with its placeholders.
      if (suggestion.template) setText(suggestion.text);
      else void submitRef.current(suggestion.text);
    },
    [onSuggestionPicked, setText],
  );
  const suggestions = useComposerSuggestions({
    draft: draft.text,
    enabled: firstTurn && !closed,
    welcome: welcomeSuggestions,
    matches: suggestionMatches,
    onPick: pickSuggestion,
  });

  // ── The field: focus, and its keys ──
  const inputRef = useRef<TextInput | null>(null);
  useFocusWhenPresented(presentedProgress, () => inputRef.current?.focus());
  // Starting an edit puts the caret in the composer that now holds the question: the Edit press
  // left focus on the row's button, so typing went nowhere and Escape could not reach the edit.
  const editingId = editing?.messageId;
  useEffect(() => {
    if (editingId !== undefined) inputRef.current?.focus();
  }, [editingId]);
  const { onKeyPress: onSuggestionKeyPress } = suggestions;
  const cancelEdit = edit.cancel;
  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      // Escape leaves an edit, as its Cancel does: it is the top-most thing open while the
      // question is being rewritten.
      if (editing !== undefined && event.nativeEvent.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
        return;
      }
      onSuggestionKeyPress(event);
    },
    [editing, cancelEdit, onSuggestionKeyPress],
  );

  return {
    text: draft.text,
    setText,
    photos,
    addAttachment,
    removeAttachment,
    address,
    turnOptions,
    edit,
    editing,
    firstTurn,
    sendTurn,
    submit,
    regenerate,
    suggestions: { ...suggestions, onPick: pickSuggestion },
    inputRef,
    onKeyPress,
  };
}
