/**
 * Fixtures written by the API's OWN SSE writers.
 *
 * Nothing here spells out a chunk by hand. `packages/api/src/lib/streaming-helpers.ts`,
 * `.../chat/sse-writer.ts` and `.../sse-emitter.ts` are the three modules that
 * put bytes on the wire for `POST /v1/chat/completions`, and they are imported
 * here and pointed at a recording `res`. A change to the wire that this client
 * cannot read therefore fails this package's tests, in the same repository, in
 * the same commit — which is the only arrangement under which "the client
 * matches the server" stays true.
 *
 * The import reaches across workspaces deliberately: a copied fixture is a
 * fixture that drifts, and drift is the entire failure mode being defended
 * against.
 */
import { createResponseSSEEmitter } from '../../api/src/lib/sse-emitter.js';
import { SSEWriter } from '../../api/src/lib/chat/sse-writer.js';
import {
  makeChunk,
  writeContentChunk,
  writeStopChunk,
  writeTextChunk,
} from '../../api/src/lib/streaming-helpers.js';

/** The structural slice of Express's `Response` the writers actually touch. */
type WriterResponse = Parameters<typeof writeContentChunk>[0];

export interface Recorder {
  /** Pass to the API's writers. */
  readonly res: WriterResponse;
  /** Everything written so far, as the client would receive it. */
  wire(): string;
}

export function recorder(): Recorder {
  const writes: string[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    socket: { setNoDelay: () => undefined },
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    end: () => undefined,
  };
  return { res: res as unknown as WriterResponse, wire: () => writes.join('') };
}

export const REQUEST_ID = 'chatcmpl-0199bb4e-0341-725e-a905-11001c3659b4';
export const MODEL = 'acme/chat-1';

/** A recorder plus the API helpers already bound to it. */
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
  const { res, wire } = recorder();
  const sse = new SSEWriter(res);
  const emitter = createResponseSSEEmitter(res, () => undefined);

  return {
    wire,
    text: (content) => void writeTextChunk(res, REQUEST_ID, MODEL, content),
    synthetic: (content, meta) => writeContentChunk(res, REQUEST_ID, MODEL, content, meta),
    stop: (reason) => writeStopChunk(res, REQUEST_ID, MODEL, reason),
    event: (name, data) => emitter.emit(name, data),
    // The route writes this one itself rather than through the emitter
    // (`routes/v1/chat-completions.ts`), so the fixture writes it the same way.
    agentTurn: (data) => void res.write(`event: alia.agent_turn\ndata: ${JSON.stringify(data)}\n\n`),
    error: (payload) => sse.writeError(payload),
    done: () => sse.done(),
    usage: (usage) => void res.write(`data: ${JSON.stringify({ ...makeChunk(REQUEST_ID, MODEL, []), usage })}\n\n`),
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
