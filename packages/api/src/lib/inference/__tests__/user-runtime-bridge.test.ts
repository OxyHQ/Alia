import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The transport that lets a model on the person's own machine answer a turn
 * Alia assembled — `lib/inference/user-runtime-bridge.ts`.
 *
 * Three properties are worth a test here, and they are not the same property:
 *
 *  1. **The identifier round-trips.** `local/<runtime>/<model>` is split on the
 *     FIRST separator, because a real Ollama tag contains both slashes and
 *     colons (`hf.co/user/repo:Q4_K_M`) and a greedy split addresses a
 *     different model than the one chosen — silently, with a plausible answer.
 *  2. **Bytes arrive unaltered.** The whole design rests on the browser copying
 *     bytes it does not parse, so what the socket delivers must be what the AI
 *     SDK reads.
 *  3. **A run may only be answered by its own user.** The run id is
 *     unguessable, but an id is not an authorisation.
 *
 * The socket layer is faked because there is no server here; nothing else is.
 */

const sockets: Array<{ id: string; data: Record<string, unknown> }> = [];
const emitted: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];

vi.mock('../../../socket.js', () => ({
  getIO: () => ({
    in: (room: string) => ({
      fetchSockets: async () => (room.startsWith('user-runtime:') ? sockets : []),
    }),
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => {
        emitted.push({ room, event, payload });
      },
    }),
  }),
}));

// No Redis: one task, so the local delivery path is the only path — which is
// also the configuration a developer runs, and the one a single ECS task runs.
vi.mock('../../redis.js', () => ({ getRedisClient: () => null }));

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child, v1: child, models: child } };
});

import {
  deliverUserRuntimeMessage,
  formatUserRuntimeModel,
  listUserRuntimes,
  parseUserRuntimeModel,
  userRuntimeCanServe,
  userRuntimeFetch,
} from '../user-runtime-bridge.js';

const OWNER = 'user-1';
const MODEL = 'llama3.1:8b';

function offerRuntime(id: string, models: string[] = [MODEL], socketId = `sock-${id}`) {
  sockets.push({ id: socketId, data: { localRuntime: { id, label: 'Chrome on the desktop', models } } });
}

beforeEach(() => {
  sockets.length = 0;
  emitted.length = 0;
});

describe('the identifier a person selects', () => {
  it('splits on the first separator, so a tag with slashes survives', () => {
    expect(parseUserRuntimeModel('local/rt-1/hf.co/user/repo:Q4_K_M')).toEqual({
      runtimeId: 'rt-1',
      model: 'hf.co/user/repo:Q4_K_M',
    });
  });

  it('round-trips through the spelling the API hands out', () => {
    const id = formatUserRuntimeModel('rt-1', 'hf.co/user/repo:Q4_K_M');
    expect(parseUserRuntimeModel(id)).toEqual({ runtimeId: 'rt-1', model: 'hf.co/user/repo:Q4_K_M' });
  });

  it('claims nothing that is not one', () => {
    // The negative half matters as much: a parser that accepted these would
    // route an ordinary Alia turn into a transport with no runtime behind it.
    expect(parseUserRuntimeModel('kaana-v1')).toBeNull();
    expect(parseUserRuntimeModel('openai/gpt-5')).toBeNull();
    expect(parseUserRuntimeModel('local/rt-1')).toBeNull();
    expect(parseUserRuntimeModel('local/rt-1/')).toBeNull();
    expect(parseUserRuntimeModel('local//model')).toBeNull();
    expect(parseUserRuntimeModel(undefined)).toBeNull();
  });
});

describe('what a person has connected', () => {
  it('reports one entry per device even when several tabs offer it', async () => {
    offerRuntime('rt-1', [MODEL], 'sock-a');
    offerRuntime('rt-1', [MODEL], 'sock-b');
    offerRuntime('rt-2', ['qwen3:4b'], 'sock-c');

    expect(await listUserRuntimes(OWNER)).toEqual([
      { id: 'rt-1', label: 'Chrome on the desktop', models: [MODEL] },
      { id: 'rt-2', label: 'Chrome on the desktop', models: ['qwen3:4b'] },
    ]);
  });

  it('ignores a socket in the room that is offering nothing', async () => {
    sockets.push({ id: 'sock-x', data: {} });
    sockets.push({ id: 'sock-y', data: { localRuntime: { id: 'rt-3' } } });
    expect(await listUserRuntimes(OWNER)).toEqual([]);
  });

  it('answers whether a specific model can be served right now', async () => {
    offerRuntime('rt-1', [MODEL]);
    await expect(userRuntimeCanServe(OWNER, { runtimeId: 'rt-1', model: MODEL })).resolves.toBe(true);
    // A model the device no longer has, and a device that is not there at all.
    await expect(userRuntimeCanServe(OWNER, { runtimeId: 'rt-1', model: 'gone:70b' })).resolves.toBe(false);
    await expect(userRuntimeCanServe(OWNER, { runtimeId: 'rt-9', model: MODEL })).resolves.toBe(false);
  });
});

describe('a turn travelling through a runtime', () => {
  /** Start a request and wait until the socket has actually been asked. */
  async function startRequest() {
    offerRuntime('rt-1');
    const pending = userRuntimeFetch({ userId: OWNER, runtimeId: 'rt-1' })(
      'http://user-runtime.invalid/v1/chat/completions',
      { method: 'POST', body: JSON.stringify({ model: MODEL }) },
    );
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    const request = emitted[0];
    return { pending, request, runId: request.payload.runId as string };
  }

  it('asks the device that owns the model, and asks it for the right path', async () => {
    const { pending, request, runId } = await startRequest();

    // The positive control for every assertion below: an empty `emitted` and a
    // request sent to the wrong socket look identical from the response side.
    expect(request.room).toBe('sock-rt-1');
    expect(request.event).toBe('user-runtime:request');
    expect(request.payload.path).toBe('/v1/chat/completions');
    expect(request.payload.body).toBe(JSON.stringify({ model: MODEL }));

    deliverUserRuntimeMessage(OWNER, { runId, kind: 'head', status: 200 });
    deliverUserRuntimeMessage(OWNER, { runId, kind: 'end' });
    await pending;
  });

  it('hands the AI SDK exactly the bytes the device sent', async () => {
    const { pending, runId } = await startRequest();

    deliverUserRuntimeMessage(OWNER, { runId, kind: 'head', status: 200 });
    const response = await pending;
    expect(response.status).toBe(200);

    // Two frames, because a single frame cannot show that the stream CONCATENATES
    // rather than replaces — and an SSE chunk is routinely split across frames.
    deliverUserRuntimeMessage(OWNER, { runId, kind: 'chunk', data: new TextEncoder().encode('data: {"a":1}\n') });
    // The base64 spelling is what a frame arriving from another task carries.
    deliverUserRuntimeMessage(OWNER, { runId, kind: 'chunk', data: Buffer.from('\ndata: [DONE]\n\n').toString('base64') });
    deliverUserRuntimeMessage(OWNER, { runId, kind: 'end' });

    expect(await response.text()).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
  });

  it('drops a frame sent by anyone but the run owner', async () => {
    const { pending, runId } = await startRequest();
    deliverUserRuntimeMessage(OWNER, { runId, kind: 'head', status: 200 });
    const response = await pending;

    deliverUserRuntimeMessage('user-2', { runId, kind: 'chunk', data: new TextEncoder().encode('injected') });
    // The mutation control: the SAME frame from the owner does arrive, so an
    // empty body is evidence of the check rather than of a broken delivery path.
    deliverUserRuntimeMessage(OWNER, { runId, kind: 'chunk', data: new TextEncoder().encode('genuine') });
    deliverUserRuntimeMessage(OWNER, { runId, kind: 'end' });

    expect(await response.text()).toBe('genuine');
  });

  it('surfaces the device failing rather than ending the stream cleanly', async () => {
    const { pending, runId } = await startRequest();
    deliverUserRuntimeMessage(OWNER, { runId, kind: 'error', message: 'connection refused' });
    // Before the head arrives the failure is the request's; a silent resolve
    // here would read to the provider loop as an empty successful answer.
    await expect(pending).rejects.toThrow('connection refused');
  });

  it('tells the device to stop when the turn is aborted', async () => {
    offerRuntime('rt-1');
    const abort = new AbortController();
    const pending = userRuntimeFetch({ userId: OWNER, runtimeId: 'rt-1' })(
      'http://user-runtime.invalid/v1/chat/completions',
      { method: 'POST', body: '{}', signal: abort.signal },
    );
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    abort.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(emitted.map((e) => e.event)).toContain('user-runtime:abort');
  });

  it('refuses at once when the device has gone', async () => {
    // No runtime offered: the turn must fail here rather than wait out the
    // head timeout with an open SSE stream in front of the person.
    await expect(
      userRuntimeFetch({ userId: OWNER, runtimeId: 'rt-1' })('http://user-runtime.invalid/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('no longer connected');
    expect(emitted).toEqual([]);
  });
});
