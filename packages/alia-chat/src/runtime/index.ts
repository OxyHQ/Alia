/**
 * The conversation runtime: the data layer under the sheet, the screen and the Alia app.
 *
 * Layers, each depending only on the ones above it in this list:
 *
 *  1. transport — `api` (REST over the signed-in Oxy client), the turn's SSE stream
 *  2. model and state — `types`, `query-keys`, the zustand stores, the cached conversation lists
 *  3. hooks — `useConversations`…, `useConversationThread`
 *
 * Nothing here draws anything. It is also a leaf entry, `@alia.onl/sdk/runtime`, for a host that
 * needs the data layer without the chat UI (a sidebar, a test).
 */

export { AliaRuntimeProvider, useAliaRuntime } from './config';
export type {
  AliaArtifact,
  AliaRuntimeConfig,
  AliaRuntimeHost,
  AliaRuntimeProviderProps,
  AliaTurnRequest,
  AliaUsageFrame,
  OfflineConversationStore,
} from './config';
export { AliaApiError, useAliaApi } from './api';
export type { AliaApi, AliaApiRequest, AliaApiResult } from './api';
export { aliaQueryKeys } from './query-keys';
export {
  ConversationNotFoundError,
  useClearConversation,
  useConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  usePrefetchConversation,
  useRenameConversation,
  useSaveConversation,
} from './conversations';
export { useConversationThread, mergeEditedContent } from './use-conversation-thread';
export type {
  EditedContent,
  UseConversationThreadOptions,
} from './use-conversation-thread';
export type { SendOutcome } from './use-conversation-stream';
export { useConversationStore } from './conversation-store';
export type { PendingInitialMessage } from './conversation-store';
export {
  releaseAttachments,
  useComposerDraft,
  useComposerDraftStore,
  useDraftAddress,
} from './composer-draft-store';
export type {
  ComposerDraft,
  DraftAddress,
  DraftTarget,
} from './composer-draft-store';
export { useStartConversation } from './use-start-conversation';
export type { StartConversationOptions } from './use-start-conversation';
export { useTurnEdit } from './use-turn-edit';
export { buildMessageContent } from './attachment-utils';
export type { BuiltMessageContent, DroppedAttachment } from './attachment-utils';
export { UsageLimitError } from './usage-limit-error';
export type { UsageLimitDetails, UsageLimitType } from './usage-limit-error';
export { failureDetail } from './turn-failure';
export type { FailedTurn } from './turn-failure';
export type {
  Conversation,
  ConversationsInfiniteData,
  ConversationsPage,
  Message,
  MessageContent,
  PendingApproval,
  PendingApprovalResult,
  SendOptions,
} from './types';
