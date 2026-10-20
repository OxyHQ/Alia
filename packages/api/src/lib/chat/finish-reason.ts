/**
 * How a turn's end is worded on the wire, and what an answer with nothing in it is.
 *
 * `/v1/chat/completions` speaks OpenAI: `finish_reason` is one of `stop`,
 * `length`, `tool_calls`, `content_filter`. The AI SDK's unified reasons are
 * hyphenated (`tool-calls`, `content-filter`), and `error` / `other` have no
 * OpenAI word at all — they used to be forwarded as they came, which no
 * OpenAI-compatible reader recognises.
 */
import { AliaError, AliaErrorCode } from '../errors/error-codes.js';

export type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

/** The OpenAI word for an AI SDK finish reason. `error` never reaches here: it fails the turn. */
export function toOpenAIFinishReason(reason: string | undefined | null): OpenAIFinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool-calls':
    case 'tool_calls':
      return 'tool_calls';
    case 'content-filter':
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * The typed failure for a turn that ended with no text, no tool call and no
 * agent answer. A model that ran out of tokens thinking (`length`) or was
 * filtered is not "a successful empty reply": the person gets an error, nothing
 * is stored and the hold is refunded.
 */
export function emptyResponseError(reason: string | undefined | null): AliaError {
  const finish = toOpenAIFinishReason(reason);
  if (finish === 'content_filter') {
    return new AliaError({
      code: AliaErrorCode.CONTENT_FILTERED,
      message: 'The model finished with a content filter and no answer',
      retryable: false,
      reason: 'content_filter',
    });
  }
  return new AliaError({
    code: AliaErrorCode.EMPTY_RESPONSE,
    message: `The model finished (${finish}) without any answer`,
    // Running out of output budget again is the likely outcome of a retry.
    retryable: finish !== 'length',
    reason: finish === 'length' ? 'format' : 'provider_unavailable',
  });
}
