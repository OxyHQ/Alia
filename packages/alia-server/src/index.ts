export {
  ALIA_API_URL,
  AliaServerClient,
  createAliaServerClient,
  type AliaChatCompletionRequest,
  type AliaCancelTurnRequest,
  type AliaTurnCancellation,
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
  AliaToolCallDelta,
  AliaToolCallsEvent,
} from './events.js';

export { readAliaEventStream, type ReadAliaEventStreamOptions } from './stream.js';
export {
  createAliaTurnControl,
  type AliaTurnControl,
  type AliaTurnControlOptions,
} from './turn-control.js';

export { ALIA_APPLICATION_ID, ALIA_SERVICE_AUDIENCE } from './identity.js';
export {
  createAliaForOxyService,
  createAliaTransportForOxyService,
  type OxyServiceTransportFactory,
  type AliaOxyRequester,
} from './oxy.js';
