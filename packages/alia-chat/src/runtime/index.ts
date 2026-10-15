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
  SpeechPreferences,
  ThoughtOpening,
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
  ConversationThread,
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
export { useAgentActivity } from './use-agent-activity';
export type { UseAgentActivityResult } from './use-agent-activity';
export { useThoughtStore } from './thought-store';
export type {
  ThoughtScope,
  ThoughtScopeStatus,
  ThoughtSelection,
  ThoughtTab,
} from './thought-store';
export { useThreadHistory } from './use-thread-history';
export { useThreadSearch, useThreadWindow } from './use-thread-search';
export { useStartConversation } from './use-start-conversation';
export type { StartConversationOptions } from './use-start-conversation';
export { useTurnEdit } from './use-turn-edit';
export { buildMessageContent } from './attachment-utils';
export type { BuiltMessageContent, DroppedAttachment } from './attachment-utils';

// The conversation as data (also the leaf entry `@alia.onl/sdk/model`).
export * from './model';
