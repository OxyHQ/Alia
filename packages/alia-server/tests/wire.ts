/**
 * The `POST /v1/chat/completions` wire, frame by frame, as the API writes it.
 *
 * Each helper below emits exactly the bytes of the API's own SSE writer of the
 * same name (`lib/streaming-helpers.ts`, `lib/chat/sse-writer.ts` and
 * `lib/sse-emitter.ts`, in OxyHQ/Gemies). Those writers lived in this
 * repository until the backend moved to OxyHQ/Gemies on 2026-11-12, and these
 * tests imported them directly; that import cannot cross repositories, so the
 * frames are spelled here once, in one place, and nowhere else in the suite.
 *
 * What keeps them honest from the other side: Gemies runs the same client
 * suite against its live writers (its `packages/alia-server/tests/wire.ts`
 * imports them), so a change to the wire that this client cannot read fails
 * there, in the commit that makes it.
 */

export const REQUEST_ID = 'chatcmpl-0199bb4e-0341-725e-a905-11001c3659b4';
export const MODEL = 'acme/chat-1';

/** An OpenAI-compatible `chat.completion.chunk`, as `makeChunk` builds it. */
function chunk(
  choices: readonly {
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }[],
): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    system_fingerprint: 'fp_alia',
    service_tier: 'default',
    choices: choices.map((c) => ({ ...c, logprobs: null })),
  };
}

const data = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** A stream under construction, one API writer per method. */
export function aliaStream(): {
  wire(): string;
  /** `writeTextChunk` — the ordinary assistant delta. */
  text(content: string): void;
  /** `writeContentChunk` with `alia_meta` — the synthetic recovery message. */
  synthetic(content: string, meta: Record<string, unknown>): void;
  /** `writeStopChunk` — the finish frame. */
  stop(reason?: string): void;
  /** `createResponseSSEEmitter().emit` — a named product event. */
  event(name: string, data: Record<string, unknown>): void;
  /** The raw `event: alia.agent_turn` frame the route writes inline. */
  agentTurn(data: Record<string, unknown>): void;
  /** `SSEWriter.writeError` — an in-stream error, and the `[DONE]` after it. */
  error(payload: Record<string, unknown>): void;
  /** `SSEWriter.done` — `data: [DONE]`. */
  done(): void;
  /** A usage-only frame, as `include_usage` produces. */
  usage(usage: Record<string, unknown>): void;
} {
  const writes: string[] = [];
  const write = (frame: string): void => void writes.push(frame);

  return {
    wire: () => writes.join(''),
    text: (content) => write(data(chunk([{ index: 0, delta: { content }, finish_reason: null }]))),
    synthetic: (content, meta) =>
      write(
        data({
          ...chunk([{ index: 0, delta: { content }, finish_reason: null }]),
          alia_meta: meta,
        }),
      ),
    stop: (reason = 'stop') => write(data(chunk([{ index: 0, delta: {}, finish_reason: reason }]))),
    event: (name, payload) => write(`event: ${name}\n${data(payload)}`),
    // The route writes this one itself rather than through the emitter.
    agentTurn: (payload) => write(`event: alia.agent_turn\n${data(payload)}`),
    error: (payload) => {
      write(
        data({
          error: {
            message: payload.message || 'An error occurred.',
            type: payload.type || 'server_error',
            param: payload.param || null,
            code: payload.code || null,
            ...(typeof payload.retryable === 'boolean' ? { retryable: payload.retryable } : {}),
            ...(typeof payload.retryAfter === 'number' ? { retryAfter: payload.retryAfter } : {}),
            ...(typeof payload.reference === 'string' ? { reference: payload.reference } : {}),
          },
        }),
      );
      write('data: [DONE]\n\n');
    },
    done: () => write('data: [DONE]\n\n'),
    usage: (usage) => write(data({ ...chunk([]), usage })),
  };
}

/** Serve a string as a `Response`, optionally in awkward byte slices. */
export function sseResponse(
  wire: string,
  options: { contentType?: string; slices?: readonly number[]; status?: number } = {},
): Response {
  const { contentType = 'text/event-stream; charset=utf-8', status = 200 } = options;
  const bytes = new TextEncoder().encode(wire);
  const boundaries = [...(options.slices ?? [bytes.length]), bytes.length];

  let offset = 0;
  const parts: Uint8Array[] = [];
  for (const boundary of boundaries) {
    if (boundary <= offset) continue;
    parts.push(bytes.slice(offset, boundary));
    offset = boundary;
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    { status, headers: { 'Content-Type': contentType } },
  );
}
