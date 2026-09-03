/**
 * The user's own machine as the thing that generates tokens.
 *
 * A person running Ollama (or LM Studio, llama.cpp, vLLM — anything speaking
 * the OpenAI shape) can select that model in Alia. Nothing about the turn
 * changes: the system prompt, the tools, the memory, the persistence and the
 * title generation are assembled here exactly as they are for a hosted model.
 * Only the hop that produces tokens is different — instead of leaving for a
 * provider, the request is handed DOWN to a socket the person's own browser
 * holds open, that browser performs an ordinary `fetch` against its own
 * `localhost`, and the bytes come back up unaltered.
 *
 * ## This is not a provider, and the distinction is load-bearing
 *
 * `AGENTS.md` forbids adding provider adapters, key pools or routing tables to
 * `packages/api` — inference belongs to Kaana. Kaana is server-side and cannot
 * reach a user's `localhost`, so this case falls outside its reach by
 * construction rather than by preference. What is modelled here is USER
 * COMPUTE: no credential, no key manager, no rate table, no entry in
 * `KAANA_ROUTING_PROFILES`, and — see `lib/chat/provider-loop.ts` — no fallback. A local
 * turn that fails, fails. Substituting a hosted model would send a conversation
 * to an operator the person deliberately avoided, and bill credits that were
 * never reserved.
 *
 * ## Why there is no protocol adapter in this file
 *
 * The AI SDK takes a `fetch` of your choosing. So rather than translating
 * OpenAI stream chunks into `LanguageModelV2` parts by hand — a second parser
 * to keep in step with the first — {@link userRuntimeFetch} returns a `Response`
 * whose body is fed by the socket, and the SDK's own OpenAI parsing handles
 * deltas, tool calls and usage. The browser copies bytes and understands none
 * of them.
 *
 * ## Crossing instances
 *
 * The task serving `POST /v1/chat/completions` is not necessarily the task
 * holding the person's socket. Requests travel by socket.io room, which the
 * Redis adapter already fans out across tasks. Replies travel back over one
 * Redis channel: whichever task receives a chunk delivers it locally if it owns
 * the run, and publishes it otherwise. Without Redis there is exactly one task,
 * so the local path is the only path and the whole thing degrades to a map
 * lookup.
 */
import { log } from '../logger.js';
import { getRedisClient } from '../redis.js';

/** The `provider` value that marks a resolved model as served by its owner's machine. */
export const USER_RUNTIME_PROVIDER = 'user-runtime';

/** The reserved namespace a selectable local model is named under. */
const MODEL_PREFIX = 'local/';

/** How long a runtime has to answer with response headers before the turn gives up. */
const HEAD_TIMEOUT_MS = 30_000;

/**
 * The most one run may stream back before it is cut off.
 *
 * The bytes are buffered in this process until the AI SDK reads them, and the
 * thing producing them is a client. A completion is orders of magnitude under
 * this; anything approaching it is either a broken runtime or someone using a
 * turn they were not billed for as a way to make a server hold memory.
 */
const MAX_RUN_BYTES = 32 * 1024 * 1024;

const REDIS_CHANNEL = 'alia:user-runtime';

/** The socket.io room every runtime a person offers joins. */
export function userRuntimeRoom(userId: string): string {
  return `user-runtime:${userId}`;
}

/**
 * A runtime on offer, as its owner's other devices see it.
 *
 * `id` is minted by the client and kept in its own storage, NOT the socket id:
 * a selected model has to survive a reconnect, and a socket id does not. There
 * is deliberately no endpoint URL here — the address of the person's local
 * server never leaves their browser, which is what keeps the server's
 * server-side-request-forgery surface at exactly zero.
 */
export interface UserRuntimePresence {
  id: string;
  label: string;
  models: string[];
}

interface BoundRuntime extends UserRuntimePresence {
  socketId: string;
}

/** A local model selection, as it travels on the request's `model` field. */
export interface UserRuntimeSelection {
  runtimeId: string;
  model: string;
}

/**
 * `local/<runtimeId>/<model>` → its two halves, or `null` for anything else.
 *
 * Split on the FIRST separator only: a model name may itself contain slashes
 * and colons (`hf.co/user/repo:Q4_K_M` is a real Ollama tag), and a greedy
 * split would silently address a different model than the one chosen.
 */
export function parseUserRuntimeModel(id: unknown): UserRuntimeSelection | null {
  if (typeof id !== 'string' || !id.startsWith(MODEL_PREFIX)) return null;
  const rest = id.slice(MODEL_PREFIX.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) return null;
  const model = rest.slice(separator + 1);
  if (model.length === 0) return null;
  return { runtimeId: rest.slice(0, separator), model };
}

/** The inverse, so the catalogue surface and the client agree on one spelling. */
export function formatUserRuntimeModel(runtimeId: string, model: string): string {
  return `${MODEL_PREFIX}${runtimeId}/${model}`;
}

function presenceOf(value: unknown): UserRuntimePresence | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { id, label, models } = candidate;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof label !== 'string') return null;
  if (!Array.isArray(models) || models.some((m) => typeof m !== 'string')) return null;
  return { id, label, models: models as string[] };
}

/**
 * Every runtime this user currently offers, from any of their devices.
 *
 * `fetchSockets()` is answered by the Redis adapter across tasks and carries
 * each socket's `data`, so the presence record needs no store of its own —
 * which is the point. A runtime's lifetime IS its socket's lifetime; anything
 * persisted would outlive the tab and advertise a model that cannot answer.
 */
async function boundRuntimes(userId: string): Promise<BoundRuntime[]> {
  const { getIO } = await import('../../socket.js');
  const io = getIO();
  if (!io) return [];
  const sockets = await io.in(userRuntimeRoom(userId)).fetchSockets();
  const seen = new Set<string>();
  return sockets.flatMap((socket) => {
    const presence = presenceOf((socket.data as Record<string, unknown> | undefined)?.localRuntime);
    // Two tabs on one machine announce the same runtime; the first to answer serves it.
    if (presence === null || seen.has(presence.id)) return [];
    seen.add(presence.id);
    return [{ ...presence, socketId: socket.id }];
  });
}

export async function listUserRuntimes(userId: string): Promise<UserRuntimePresence[]> {
  return (await boundRuntimes(userId)).map(({ id, label, models }) => ({ id, label, models }));
}

/** The socket that can serve `runtimeId`, or `null` if that device is gone. */
async function findBoundRuntime(userId: string, runtimeId: string): Promise<BoundRuntime | null> {
  return (await boundRuntimes(userId)).find((runtime) => runtime.id === runtimeId) ?? null;
}

/**
 * True if this user has a runtime that can serve `model` right now.
 *
 * Checked BEFORE the SSE stream opens, so a tab that has been closed shows up
 * as a greyed-out model in the picker rather than as a turn that dies halfway.
 */
export async function userRuntimeCanServe(
  userId: string,
  selection: UserRuntimeSelection,
): Promise<boolean> {
  const runtime = await findBoundRuntime(userId, selection.runtimeId);
  return runtime !== null && runtime.models.includes(selection.model);
}

/** One frame of a runtime's reply, travelling from the socket to whoever owns the run. */
export type UserRuntimeMessage =
  | { runId: string; kind: 'head'; status: number }
  | { runId: string; kind: 'chunk'; data: Uint8Array | string }
  | { runId: string; kind: 'end' }
  | { runId: string; kind: 'error'; message: string };

interface RunSink {
  userId: string;
  head: (status: number) => void;
  chunk: (data: Uint8Array) => void;
  end: () => void;
  fail: (message: string) => void;
}

const pendingRuns = new Map<string, RunSink>();

let subscriberStarted = false;

/**
 * Listen for reply frames belonging to runs this task owns.
 *
 * A single channel rather than one per run: subscribe/unsubscribe races around
 * a stream that lives for seconds are a worse failure than the handful of
 * frames a task discards because it does not own the run.
 */
function ensureSubscriber(): void {
  if (subscriberStarted) return;
  subscriberStarted = true;
  const client = getRedisClient();
  if (!client) return;
  const subscriber = client.duplicate();
  subscriber.on('error', (err: Error) => log.general.warn({ err }, 'user-runtime subscriber error'));
  subscriber.on('message', (_channel: string, raw: string) => {
    try {
      const parsed = JSON.parse(raw) as { userId: string; msg: UserRuntimeMessage };
      applyLocally(parsed.userId, parsed.msg);
    } catch (err) {
      log.general.warn({ err }, 'user-runtime frame was not readable');
    }
  });
  subscriber.subscribe(REDIS_CHANNEL).catch((err: Error) => {
    log.general.warn({ err }, 'user-runtime subscribe failed — cross-task local models are off');
  });
}

function applyLocally(userId: string, msg: UserRuntimeMessage): boolean {
  const sink = pendingRuns.get(msg.runId);
  if (!sink) return false;
  /**
   * A run may only ever be answered by the user it was issued to. The run id is
   * unguessable, but an id is not an authorisation, and the socket that sends a
   * frame is authenticated independently of the request that opened the run.
   */
  if (sink.userId !== userId) {
    log.general.warn({ runId: msg.runId }, 'user-runtime frame from the wrong user, dropped');
    return true;
  }
  switch (msg.kind) {
    case 'head':
      sink.head(msg.status);
      return true;
    case 'chunk':
      sink.chunk(typeof msg.data === 'string' ? Buffer.from(msg.data, 'base64') : msg.data);
      return true;
    case 'end':
      sink.end();
      return true;
    case 'error':
      sink.fail(msg.message);
      return true;
  }
}

/**
 * Hand a frame received on a socket to whichever task is waiting for it.
 *
 * Local first, Redis only as the fallback — so the common case (one task, or
 * the socket and the request on the same task) never encodes a token twice.
 */
export function deliverUserRuntimeMessage(userId: string, msg: UserRuntimeMessage): void {
  if (applyLocally(userId, msg)) return;
  const client = getRedisClient();
  if (!client) return;
  const wire =
    msg.kind === 'chunk' && typeof msg.data !== 'string'
      ? { ...msg, data: Buffer.from(msg.data).toString('base64') }
      : msg;
  client.publish(REDIS_CHANNEL, JSON.stringify({ userId, msg: wire })).catch((err: Error) => {
    log.general.warn({ err }, 'user-runtime frame could not be forwarded');
  });
}

/** Binding carried on the resolved model so the fetch below knows whose machine to ask. */
export interface UserRuntimeBinding {
  userId: string;
  runtimeId: string;
}

/**
 * A `fetch` that answers from the user's own machine.
 *
 * Handed to `createOpenAI({ fetch })` in `lib/chat-core.ts`. One call per step:
 * a turn with tool calls invokes this several times on the same model instance,
 * so the run id is minted HERE and never on the instance.
 */
export function userRuntimeFetch(binding: UserRuntimeBinding) {
  return async function fetchThroughUserRuntime(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;

    const runtime = await findBoundRuntime(binding.userId, binding.runtimeId);
    if (runtime === null) {
      throw new Error('The local runtime for this model is no longer connected.');
    }

    const { getIO } = await import('../../socket.js');
    const io = getIO();
    if (!io) throw new Error('Realtime transport is unavailable.');

    ensureSubscriber();

    const runId = crypto.randomUUID();
    let settleHead: ((status: number) => void) | null = null;
    let rejectHead: ((error: Error) => void) | null = null;
    const headArrived = new Promise<number>((resolve, reject) => {
      settleHead = resolve;
      rejectHead = reject;
    });

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    let streamedBytes = 0;
    const finish = () => {
      if (closed) return;
      closed = true;
      pendingRuns.delete(runId);
      clearTimeout(headTimer);
    };

    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      cancel() {
        finish();
        io.to(runtime.socketId).emit('user-runtime:abort', { runId });
      },
    });

    const fail = (message: string) => {
      const error = new Error(message);
      rejectHead?.(error);
      if (controller !== null && !closed) {
        try {
          controller.error(error);
        } catch {
          // The consumer already tore the stream down; nothing left to fail.
        }
      }
      finish();
    };

    const headTimer = setTimeout(
      () => fail('The local runtime did not respond in time.'),
      HEAD_TIMEOUT_MS,
    );

    pendingRuns.set(runId, {
      userId: binding.userId,
      head: (status) => {
        clearTimeout(headTimer);
        settleHead?.(status);
      },
      chunk: (data) => {
        if (closed) return;
        streamedBytes += data.byteLength;
        if (streamedBytes > MAX_RUN_BYTES) {
          fail('The local runtime sent more data than a completion can contain.');
          return;
        }
        controller?.enqueue(data);
      },
      end: () => {
        if (!closed) {
          try {
            controller?.close();
          } catch {
            // Already closed by a cancel that raced the runtime's last frame.
          }
        }
        finish();
      },
      fail,
    });

    init?.signal?.addEventListener('abort', () => {
      io.to(runtime.socketId).emit('user-runtime:abort', { runId });
      fail('The request was aborted.');
    });

    /**
     * Only `content-type` is forwarded. The provider factory sets an
     * `Authorization` header from an empty API key, and a local server has no
     * use for it — forwarding request headers wholesale is how a credential
     * ends up somewhere it was never meant to go.
     */
    io.to(runtime.socketId).emit('user-runtime:request', {
      runId,
      path,
      method: init?.method ?? 'POST',
      body: typeof init?.body === 'string' ? init.body : null,
    });

    const status = await headArrived;
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}
