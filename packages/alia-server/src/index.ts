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
  type AliaFailureDetail,
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

export { ALIA_APPLICATION_ID, ALIA_SERVICE_AUDIENCE } from './identity.js';
export {
  createAliaForOxyService,
  createAliaTransportForOxyService,
  type OxyServiceTransportFactory,
} from './oxy.js';
