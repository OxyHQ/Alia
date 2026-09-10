/**
 * Alia's product chat stream, as the Electron main process consumes it
 * (`POST /alia/chat`).
 *
 * ## Why this replaces the `openai` package here
 *
 * The chat used to go through `new OpenAI({ baseURL: `${baseUrl}/v1` })`, which
 * derives `POST /v1/chat/completions` itself. The handler is the same one
 * (`packages/api/src/routes/chat.ts`), so the request and the OpenAI-shaped
 * `data:` chunks are unchanged — but the SDK's stream parser DROPS every named
 * event: for an `event: alia.reasoning` frame it parses the payload and yields
 * it as if it were a completion chunk, and a chunk with no `choices` is skipped
 * by every consumer. Measured in
 * `packages/api/src/routes/v1/__tests__/chatFlowFixtures.test.ts` ("never emits a
 * reasoning delta inside a generic chunk"): the server has exactly one
 * reasoning surface and it is the named event, so the `delta.reasoning` reader
 * this file used to carry was dead code and `chat:thinking` never fired.
 *
 * The SDK also had no notion of `alia_meta.synthetic` — the marker on the
 * stand-in text the server streams when every provider is busy or a provider
 * died mid-answer — so "I'm sorry, all models are currently busy" was rendered
 * and REMEMBERED as an answer, and the next turn argued with it.
 *
 * A fetch and a frame reader are ~150 lines. The `openai` dependency stays for
 * its message and tool TYPES, which are the vocabulary the server accepts.
 *
 * ## The wire contract this reads
 *
 * Trust the code, not the docs: `packages/api/src/lib/chat/stream-runner.ts`,
 * `lib/chat/provider-loop.ts`, `lib/chat/sse-writer.ts` and
 * `lib/streaming-helpers.ts` are what write the frames below.
 *
 *  - `: keep-alive` comments, ignored per the SSE specification.
 *  - Unnamed `data:` frames: OpenAI `chat.completion.chunk` objects carrying
 *    `choices[0].delta.content`, `choices[0].delta.tool_calls` and
 *    `choices[0].finish_reason`. A chunk may carry `alia_meta: { synthetic,
 *    retryable }`, in which case its content is a stand-in and not an answer.
 *  - Named frames `event: alia.<name>\ndata: {…}`: `alia.reasoning`
 *    (`{ content }`), `alia.tool_result` (`{ tool_call_id, name, output }`) and
 *    a handful this process has no use for (`alia.title`, `alia.agent`,
 *    `alia.plan_preview`, `alia.model_switch`, …), passed through as `event`.
 *  - `data: {"error": {…}}` followed by `[DONE]`: a refusal AFTER the headers
 *    went out. Surfaced as {@link AliaChatError}, never as text.
 *  - `data: [DONE]` closes the stream.
 *
 * ## Why this is a copy rather than a shared module
 *
 * `packages/alia-codea` and `@alia-codea/cli` carry the same reader, for the
 * reason `./catalogue.ts` states: the CLI is published and the extension is
 * bundled, so neither can depend on an unpublished workspace package, and a
 * shared module only one of three consumers could use is a copy with extra
 * ceremony. The three are kept in step by their tests, which feed the same
 * frames.
 */

import type OpenAI from 'openai'

// ── Frames ──────────────────────────────────────────────────────────────────

export interface SseFrame {
  /** The `event:` name, or `''` for an unnamed (OpenAI-shaped) frame. */
  readonly event: string
  /** The `data:` payload, trimmed. `[DONE]` is passed through as-is. */
  readonly data: string
}

export interface SseFrameReader {
  /** Feed one decoded chunk; get back every frame it completed. */
  push(chunk: string): SseFrame[]
}

/**
 * Reassemble an SSE byte stream into whole frames.
 *
 * A port of `packages/app/lib/chat/sse-frame-reader.ts`, and the reason it is
 * an object rather than two variables in a read loop is the bug that module
 * records: a frame is `event: X\ndata: {…}\n\n` and a chunk boundary falls
 * wherever the network puts it, so the event name and the payload must both
 * outlive a `read()`. The largest frames — tool results — are the ones most
 * likely to be split.
 */
export function createSseFrameReader(): SseFrameReader {
  let buffer = ''
  let currentEventType = ''

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk

      const frames: SseFrame[] = []
      const lines = buffer.split('\n')
      // Whatever followed the last newline is an incomplete line, unless the
      // chunk ended on a boundary, in which case it is `''` and costs nothing.
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        // A CRLF stream leaves the CR on every line; `data: {…}\r` is not JSON.
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim()
          continue
        }

        // A blank line closes a frame, so the NEXT frame's `data:` cannot
        // inherit this frame's event name.
        if (line === '') {
          currentEventType = ''
          continue
        }

        if (line.startsWith('data: ')) {
          frames.push({ event: currentEventType, data: line.slice(6).trim() })
          currentEventType = ''
          continue
        }

        // Comments (`: keep-alive`) and fields this client does not read.
      }

      return frames
    }
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

/** One `delta.tool_calls[]` entry, exactly as the chunk carries it. */
export interface ToolCallDelta {
  readonly index?: number
  readonly id?: string
  readonly function?: { readonly name?: string; readonly arguments?: string }
}

/** A tool call assembled from its deltas; the shape the history stores. */
export interface StreamedToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type AliaStreamEvent =
  /** Answer text the user reads. */
  | { readonly type: 'content'; readonly text: string }
  /** Chain-of-thought from `alia.reasoning`; shown, never stored as the answer. */
  | { readonly type: 'reasoning'; readonly text: string }
  /** Tool-call fragments; accumulate with {@link mergeToolCallDeltas}. */
  | { readonly type: 'tool_calls'; readonly deltas: readonly ToolCallDelta[] }
  /**
   * `alia.tool_result`. For a tool THIS client defined the output is the
   * server's echo of the arguments (`lib/tool-converter.ts`) — Alia does not
   * run it, this process does — so a consumer dispatches on the generic
   * `tool_calls` frame and reads this only for tools the server ran itself.
   */
  | { readonly type: 'tool_result'; readonly toolCallId: string; readonly name: string; readonly output: unknown }
  /**
   * The stand-in text the server sends instead of an answer. Never rendered as
   * one, never stored as one; `retryable` says whether resending would help.
   */
  | { readonly type: 'synthetic'; readonly text: string; readonly retryable: boolean }
  | { readonly type: 'finish'; readonly reason: string }
  /** Any other named product event, for a consumer that wants it. */
  | { readonly type: 'event'; readonly name: string; readonly data: Record<string, unknown> }

/**
 * A refusal from Alia's API, before or during the stream.
 *
 * `status` is the HTTP status for a refusal that came as a response, and `null`
 * for one that arrived as an error frame after the headers were already out.
 * `code` is the server's own `error.code` (`MODEL_NOT_IN_PLAN`,
 * `unknown_routing_profile`, `authentication_required`, …) when it sent one.
 */
export class AliaChatError extends Error {
  readonly status: number | null
  readonly code: string | null
  readonly retryable: boolean

  constructor(
    message: string,
    options: { status?: number | null; code?: string | null; retryable?: boolean } = {}
  ) {
    super(message)
    this.name = 'AliaChatError'
    this.status = options.status ?? null
    this.code = options.code ?? null
    this.retryable = options.retryable ?? false
  }
}

// ── Request ─────────────────────────────────────────────────────────────────

export interface AliaChatRequestBody {
  readonly model: string
  readonly messages: readonly OpenAI.Chat.ChatCompletionMessageParam[]
  readonly tools?: readonly OpenAI.Chat.ChatCompletionTool[]
  readonly tool_choice?: 'auto' | 'none'
  readonly temperature?: number
  readonly max_tokens?: number
}

export interface AliaChatStreamOptions {
  readonly baseUrl: string
  /** The Oxy session bearer. Read at call time by the caller, never cached. */
  readonly accessToken: string
  readonly body: AliaChatRequestBody
  readonly signal?: AbortSignal
  /** Injectable for tests; defaults to the global. */
  readonly fetch?: typeof fetch
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

/**
 * The server's error envelope, in either of its two spellings.
 *
 * The chat handler writes `{ error: { message, type, param, code } }`; the auth
 * middleware writes `{ error: 'Authentication required' }`. Both are read, and
 * a body that is neither still yields a message naming the status.
 */
function errorFrom(payload: unknown, status: number | null): AliaChatError {
  const body = asObject(payload)
  const error = body?.error
  const fallback = status === null ? 'Alia returned an error.' : `Alia API error (HTTP ${status}).`
  if (typeof error === 'string') {
    return new AliaChatError(error, { status, retryable: isRetryableStatus(status) })
  }
  const detail = asObject(error)
  const message = typeof detail?.message === 'string' ? detail.message : fallback
  const code = typeof detail?.code === 'string' ? detail.code : null
  const retryable = detail?.retryable === true || isRetryableStatus(status)
  return new AliaChatError(message, { status, code, retryable })
}

function isRetryableStatus(status: number | null): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/**
 * Interpret one frame as zero or more events.
 *
 * Throws {@link AliaChatError} for an error frame. Returns `null` for `[DONE]`,
 * which the caller treats as the end of the stream, and `[]` for anything
 * unreadable — a frame that is not JSON is skipped rather than fatal, which is
 * what the app does and what keeps one malformed keep-alive from killing a
 * turn.
 */
export function interpretFrame(frame: SseFrame): AliaStreamEvent[] | null {
  if (frame.data === '[DONE]') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(frame.data)
  } catch {
    return []
  }
  const payload = asObject(parsed)
  if (payload === null) return []

  if (frame.event !== '') {
    switch (frame.event) {
      case 'alia.reasoning': {
        const text = typeof payload.content === 'string' ? payload.content : ''
        return text === '' ? [] : [{ type: 'reasoning', text }]
      }
      case 'alia.tool_result': {
        const toolCallId = typeof payload.tool_call_id === 'string' ? payload.tool_call_id : ''
        const name = typeof payload.name === 'string' ? payload.name : ''
        return [{ type: 'tool_result', toolCallId, name, output: payload.output }]
      }
      default:
        return [{ type: 'event', name: frame.event, data: payload }]
    }
  }

  if (payload.error !== undefined) throw errorFrom(payload, null)

  const events: AliaStreamEvent[] = []
  const choice = Array.isArray(payload.choices) ? asObject(payload.choices[0]) : null
  const delta = choice === null ? null : asObject(choice.delta)
  const content = typeof delta?.content === 'string' ? delta.content : ''

  const meta = asObject(payload.alia_meta)
  if (meta?.synthetic === true) {
    // The whole chunk is the stand-in. Its text goes out under its own event
    // and nowhere else, so no consumer can render it by forgetting to check.
    events.push({ type: 'synthetic', text: content, retryable: meta.retryable === true })
  } else if (content !== '') {
    events.push({ type: 'content', text: content })
  }

  if (delta !== null && Array.isArray(delta.tool_calls)) {
    const deltas = delta.tool_calls
      .map(asObject)
      .filter((call): call is JsonObject => call !== null) as unknown as ToolCallDelta[]
    if (deltas.length > 0) events.push({ type: 'tool_calls', deltas })
  }

  if (typeof choice?.finish_reason === 'string') {
    events.push({ type: 'finish', reason: choice.finish_reason })
  }

  return events
}

/**
 * Fold `delta.tool_calls` fragments into whole calls, by index.
 *
 * The first fragment for an index carries the id and the name; later ones
 * carry argument text to append. Three consumers used to write this loop
 * inline, twice each.
 */
export function mergeToolCallDeltas(into: StreamedToolCall[], deltas: readonly ToolCallDelta[]): void {
  for (const delta of deltas) {
    const index = delta.index ?? into.length
    const existing = into[index]
    if (existing === undefined) {
      into[index] = {
        id: delta.id ?? '',
        type: 'function',
        function: { name: delta.function?.name ?? '', arguments: delta.function?.arguments ?? '' }
      }
      continue
    }
    if (delta.id) existing.id = delta.id
    if (delta.function?.name) existing.function.name = delta.function.name
    if (delta.function?.arguments) existing.function.arguments += delta.function.arguments
  }
}

/** The calls that arrived whole: an id and a name. A sparse index is skipped. */
export function completedToolCalls(calls: readonly (StreamedToolCall | undefined)[]): StreamedToolCall[] {
  return calls.filter(
    (call): call is StreamedToolCall => call !== undefined && call.id !== '' && call.function.name !== ''
  )
}

/**
 * One streaming turn against `POST /alia/chat`.
 *
 * Yields {@link AliaStreamEvent}s as frames complete and returns when the
 * server writes `[DONE]` or closes the connection. A refusal — HTTP or an
 * in-stream error frame — is thrown as {@link AliaChatError}; an abort through
 * `signal` rejects with the runtime's `AbortError`, which callers already
 * distinguish by name. A consumer that stops iterating early releases the
 * connection: the `finally` cancels the reader.
 */
export async function* streamAliaChat(
  options: AliaChatStreamOptions
): AsyncGenerator<AliaStreamEvent, void, undefined> {
  const doFetch = options.fetch ?? fetch
  const response = await doFetch(`${options.baseUrl}/alia/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${options.accessToken}`
    },
    body: JSON.stringify({ ...options.body, stream: true }),
    signal: options.signal
  })

  if (!response.ok) {
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      // A non-JSON refusal (a proxy page, an empty body) still names its status.
    }
    throw errorFrom(payload, response.status)
  }
  if (response.body === null) {
    throw new AliaChatError('Alia returned no response body.', { status: response.status })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames = createSseFrameReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      // `{ stream: true }`: a multi-byte character split across two reads
      // decodes to U+FFFD without it.
      for (const frame of frames.push(decoder.decode(value, { stream: true }))) {
        const events = interpretFrame(frame)
        if (events === null) return
        for (const event of events) yield event
      }
    }
  } finally {
    // Reached by `[DONE]`, by an error and by a consumer that stopped early. A
    // cancelled reader on an already-closed body rejects, and that is noise.
    reader.cancel().catch(() => {})
  }
}
