import {
  AliaAbortError,
  AliaStreamError,
  describeChunk,
  isRecord,
  type AliaChunkShape,
} from './errors.js';
import type { AliaStreamEvent } from './events.js';

/** Ceilings, not tuning knobs: a runaway stream must end as an error, not as RAM. */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** SSE's default event type. A frame naming it is an ordinary data frame. */
const DEFAULT_EVENT_NAME = 'message';

export interface ReadAliaEventStreamOptions {
  readonly signal?: AbortSignal;
}

function asOptionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Turn one parsed `data:` payload into zero or more events. */
function* eventsFromChunk(value: unknown, shape: () => AliaChunkShape): Generator<AliaStreamEvent> {
  if (!isRecord(value)) throw new AliaStreamError('unexpected_chunk', shape());

  // An in-stream error payload. Alia writes `[DONE]` straight after it, so this
  // yields rather than returns: the terminal event still arrives, and a consumer
  // that stops on the error simply never asks for it.
  if (isRecord(value.error)) {
    const error = value.error;
    yield {
      type: 'error',
      code: asStringOrNull(error.code),
      message: typeof error.message === 'string' ? error.message : 'Alia ended the stream with an error.',
      errorType: asStringOrNull(error.type),
      param: asStringOrNull(error.param),
    };
    return;
  }

  if (!Array.isArray(value.choices)) throw new AliaStreamError('unexpected_chunk', shape());

  // A usage-only frame (`stream_options.include_usage`) carries no choices.
  const meta = asOptionalRecord(value.alia_meta);

  for (const rawChoice of value.choices) {
    if (!isRecord(rawChoice) || !isRecord(rawChoice.delta)) {
      throw new AliaStreamError('choice_without_delta', shape());
    }
    const delta = rawChoice.delta;

    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') throw new AliaStreamError('content_not_string', shape());
      yield { type: 'text', text: delta.content, ...(meta === undefined ? {} : { meta }) };
    }
    if (typeof delta.reasoning === 'string' && delta.reasoning !== '') {
      yield { type: 'reasoning', text: delta.reasoning };
    }
    if (typeof rawChoice.finish_reason === 'string') {
      yield { type: 'finish', reason: rawChoice.finish_reason, ...(meta === undefined ? {} : { meta }) };
    }
  }
}

interface Frame {
  readonly event: string;
  readonly data: string;
}

/**
 * Read Alia's SSE body as typed events.
 *
 * Exported for a consumer that already holds a `Response` — the client below is
 * this function plus the request and its status handling. The generator owns the
 * reader: leaving the loop early (a `break`, a thrown consumer) cancels it.
 */
export async function* readAliaEventStream(
  body: ReadableStream<Uint8Array>,
  options: ReadAliaEventStreamOptions = {},
): AsyncGenerator<AliaStreamEvent, void, undefined> {
  const { signal } = options;
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  let totalBytes = 0;
  let sawDone = false;

  const takeFrame = (): Frame | null => {
    const event = eventName;
    const lines = dataLines;
    eventName = '';
    dataLines = [];
    if (lines.length === 0) return null;
    return { event, data: lines.join('\n') };
  };

  /** One complete frame → events. Returns false once `[DONE]` has been seen. */
  function* dispatch(frame: Frame): Generator<AliaStreamEvent> {
    const named = frame.event !== '' && frame.event !== DEFAULT_EVENT_NAME;

    if (!named && frame.data === '[DONE]') {
      sawDone = true;
      yield { type: 'done' };
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(frame.data) as unknown;
    } catch {
      throw new AliaStreamError('malformed_json', { ...(named ? { event: frame.event } : {}) });
    }

    if (named) {
      yield { type: 'event', event: frame.event, data: value };
      return;
    }
    yield* eventsFromChunk(value, () => describeChunk(value));
  }

  const consumeLine = function* (rawLine: string): Generator<AliaStreamEvent> {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      const frame = takeFrame();
      if (frame !== null) yield* dispatch(frame);
      return;
    }
    if (line.startsWith(':')) return;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // `id` and `retry` are SSE's own and carry nothing Alia uses; anything else
    // is an unknown field, which the SSE spec requires be ignored.
  };

  try {
    for (;;) {
      if (signal?.aborted) throw new AliaAbortError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new AliaAbortError();

      if (value !== undefined) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_STREAM_BYTES) throw new AliaStreamError('oversized');
      }
      buffer += decoder.decode(value, { stream: !done });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield* consumeLine(line);
        if (sawDone) return;
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_FRAME_BYTES) throw new AliaStreamError('oversized');

      if (done) break;
    }

    // A body that ends without its blank line still holds a complete frame.
    if (buffer !== '') {
      yield* consumeLine(buffer);
      if (sawDone) return;
    }
    const trailing = takeFrame();
    if (trailing !== null) {
      yield* dispatch(trailing);
      if (sawDone) return;
    }

    // Reaching here means the body ended with no `[DONE]`. The answer is
    // incomplete and saying so is the whole point: a truncated turn that reads
    // as a successful short one is indistinguishable from a real short one.
    throw new AliaStreamError('truncated');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
