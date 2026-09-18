export {
  ALIA_API_URL,
  AliaServerClient,
  createAliaServerClient,
  type AliaChatCompletionRequest,
  type AliaChatMessage,
  type AliaHeaders,
  type AliaServerClientOptions,
  type AliaStreamInit,
} from './client.js';

export {
  AliaAbortError,
  AliaRequestError,
  AliaStreamError,
  type AliaChunkShape,
  type AliaStreamFailure,
} from './errors.js';

export type {
  AliaDoneEvent,
  AliaErrorEvent,
  AliaFinishEvent,
  AliaNamedEvent,
  AliaReasoningEvent,
  AliaStreamEvent,
  AliaTextEvent,
} from './events.js';

export { readAliaEventStream, type ReadAliaEventStreamOptions } from './stream.js';
