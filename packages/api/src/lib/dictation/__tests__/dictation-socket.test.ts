import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Model } from '@kaana.ai/contracts';
import { createFakeKaana, type FakeKaanaServer, voiceCatalogue } from '@kaana.ai/sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const quiet = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ log: new Proxy({}, { get: () => quiet }) }));
vi.mock('../../socket-session-auth.js', () => ({ authenticateSocketSession: vi.fn() }));

const { dictationStreamRoute } = await import('../socket.js');
const { routeWebSocketUpgrades } = await import('../../websocket-upgrades.js');
const { DICTATION_PROTOCOL_VERSION, DICTATION_STREAM_PATH } = await import('../protocol.js');
const { until } = await import('../../voice/__tests__/support.js');

/**
 * `GET /v1/audio/transcriptions/stream` over a real socket (ADR 0024), on
 * `@kaana.ai/sdk/testing`: who may dictate, the Kaana session it opens, the
 * segments the device receives, and how a dictation ends.
 */

const batchLine = voiceCatalogue.find(
  (model) => model.modelId === 'x-ai/grok-voice-transcribe-2.0',
);
if (!batchLine) throw new Error('The fake catalogue has no xAI transcription line');

/** The line as Kaana publishes it once its streaming deployment serves sessions. */
const streamingLine: Model = {
  ...batchLine,
  capabilities: {
    ...batchLine.capabilities,
    realtime: {
      transports: ['websocket'],
      sessionKinds: ['transcription'],
      inputAudioTranscription: false,
      audioFormats: { input: ['pcm16_24khz', 'g711_ulaw', 'g711_alaw'], output: [] },
    },
  },
};

/** Kaana's voice catalogue with the transcription line serving sessions too. */
const withStreamingLine = voiceCatalogue.map((model) =>
  model.modelId === streamingLine.modelId ? streamingLine : model,
);

const servers: http.Server[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

interface Setup {
  models?: readonly Model[];
  allowed?: boolean;
  finalWaitMs?: number;
}

async function serve(setup: Setup = {}) {
  const fake = createFakeKaana({ models: setup.models ?? withStreamingLine });
  const disposed = vi.fn();
  const server = http.createServer();
  servers.push(server);
  const admitted: string[] = [];
  routeWebSocketUpgrades(server, {
    socketIoPath: '/socket.io',
    routes: [
      dictationStreamRoute(undefined, {
        authenticate: async (token) =>
          token === 'good-token' ? { userId: 'user-1', sessionId: 'session-1' } : null,
        admit: async (userId) => {
          admitted.push(userId);
          return setup.allowed === false
            ? { allowed: false, retryAfterMs: 12_000 }
            : { allowed: true };
        },
        kaana: () => ({ ...fake.kaana, dispose: disposed }),
        limits: { finalWaitMs: setup.finalWaitMs ?? 1_000 },
      }),
    ],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}${DICTATION_STREAM_PATH}`,
    kaana: fake.server as FakeKaanaServer,
    admitted,
    disposed,
  };
}

interface Client {
  ws: WebSocket;
  events: Array<Record<string, unknown>>;
  closed: { code: number } | null;
  send(event: unknown): void;
}

async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const client: Client = {
    ws,
    events: [],
    closed: null,
    send: (event) => ws.send(JSON.stringify(event)),
  };
  ws.on('message', (data) => client.events.push(JSON.parse(data.toString())));
  ws.on('close', (code) => {
    client.closed = { code };
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return client;
}

const types = (client: Client) => client.events.map((event) => event.type);
const start = { type: 'dictation.start', protocol: DICTATION_PROTOCOL_VERSION, sampleRate: 24_000 };

async function ready(setup: Setup = {}, language = 'es-ES') {
  const served = await serve(setup);
  const client = await connect(served.url);
  client.send({ type: 'auth', token: 'good-token' });
  client.send({ ...start, language });
  // Audio sent before the session is ready is held and forwarded once it is.
  client.ws.send(Buffer.alloc(4_800, 1));
  await until('dictation.ready', () => types(client).includes('dictation.ready'));
  const session = served.kaana.sessions.at(-1);
  if (!session) throw new Error('No Kaana session was opened');
  return { ...served, client, session };
}

describe('who may dictate', () => {
  it('refuses an oxy_sk_ machine credential with CREDENTIAL_NOT_SUPPORTED', async () => {
    const { url, kaana } = await serve();
    const client = await connect(url);
    client.send({ type: 'auth', token: 'oxy_sk_live_abc' });
    await until('closed', () => client.closed !== null);
    expect(client.events[0]).toMatchObject({ type: 'error', code: 'CREDENTIAL_NOT_SUPPORTED' });
    expect(client.closed?.code).toBe(4003);
    expect(kaana.sessions).toHaveLength(0);
  });

  it('refuses a token Oxy does not validate, and a start with no auth', async () => {
    const { url } = await serve();
    const bad = await connect(url);
    bad.send({ type: 'auth', token: 'bad-token' });
    await until('closed', () => bad.closed !== null);
    expect(bad.events[0]).toMatchObject({ type: 'error', code: 'NOT_AUTHENTICATED' });

    const early = await connect(url);
    early.send(start);
    await until('closed', () => early.closed !== null);
    expect(early.events[0]).toMatchObject({ type: 'error', code: 'NOT_AUTHENTICATED' });
  });

  it('refuses another protocol version', async () => {
    const { url, kaana } = await serve();
    const client = await connect(url);
    client.send({ type: 'auth', token: 'good-token' });
    client.send({ ...start, protocol: DICTATION_PROTOCOL_VERSION + 1 });
    await until('closed', () => client.closed !== null);
    expect(client.events[0]).toMatchObject({ type: 'error', code: 'INVALID_REQUEST' });
    expect(kaana.sessions).toHaveLength(0);
  });

  it('counts one /v1 request per dictation and refuses over the limit, retryable', async () => {
    const { url, kaana, admitted } = await serve({ allowed: false });
    const client = await connect(url);
    client.send({ type: 'auth', token: 'good-token' });
    client.send(start);
    await until('closed', () => client.closed !== null);
    expect(admitted).toEqual(['user-1']);
    expect(client.events[0]).toMatchObject({
      type: 'error',
      code: 'TRANSCRIPTION_LIMITED',
      retryable: true,
    });
    expect(kaana.sessions).toHaveLength(0);
  });
});

describe('the Kaana session', () => {
  it('is a transcription session with interim text, no responses, and the dictation limits', async () => {
    const { session, client } = await ready();
    expect(session.model.modelId).toBe('x-ai/grok-voice-transcribe-2.0');
    expect(session.open).toMatchObject({
      kind: 'transcription',
      config: {
        inputAudioFormat: 'pcm16_24khz',
        turnDetection: { type: 'server_vad', createResponse: false, interruptResponse: false },
        inputAudioTranscription: { language: 'es-ES', interimResults: true },
      },
      limits: { maxDurationMs: 300_000, idleTimeoutMs: 30_000, maxInputAudioBytes: 14_400_000 },
    });
    expect(client.events[0]).toEqual({ type: 'dictation.ready', maxDurationMs: 300_000 });
    await until('the held audio', () =>
      session.commands.some((command) => command.type === 'input_audio.append'),
    );
  });

  it('is unavailable when no line holds a transcription session', async () => {
    const served = await serve({ models: voiceCatalogue });
    const client = await connect(served.url);
    client.send({ type: 'auth', token: 'good-token' });
    client.send(start);
    await until('closed', () => client.closed !== null);
    expect(types(client)).toEqual(['error', 'dictation.closed']);
    expect(client.events[0]).toMatchObject({ code: 'TRANSCRIPTION_UNAVAILABLE' });
    expect(served.disposed).toHaveBeenCalled();
  });
});

describe('segments', () => {
  it('numbers Kaana items in order; a final replaces what the segment showed', async () => {
    const { session, client } = await ready();
    session.emit({
      type: 'transcript.interim',
      source: 'input_audio',
      itemId: 'item_7',
      contentIndex: 0,
      text: 'hola qu',
    });
    session.emit({
      type: 'transcript.delta',
      source: 'input_audio',
      itemId: 'item_7',
      contentIndex: 0,
      text: 'Hola, ',
    });
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'item_7',
      contentIndex: 0,
      transcript: ' Hola, ¿qué tal? ',
    });
    // A late event of a final segment is never shown again.
    session.emit({
      type: 'transcript.delta',
      source: 'input_audio',
      itemId: 'item_7',
      contentIndex: 0,
      text: 'x',
    });
    session.emit({
      type: 'transcript.interim',
      source: 'input_audio',
      itemId: 'item_8',
      contentIndex: 0,
      text: 'Bien',
    });
    await until('second segment', () => client.events.length >= 5);
    expect(client.events.slice(1)).toEqual([
      { type: 'transcript.interim', segment: 0, text: 'hola qu' },
      { type: 'transcript.delta', segment: 0, text: 'Hola, ' },
      { type: 'transcript.final', segment: 0, text: 'Hola, ¿qué tal?' },
      { type: 'transcript.interim', segment: 1, text: 'Bien' },
    ]);
  });

  it('commits the open segment on dictation.commit', async () => {
    const { session, client } = await ready();
    client.send({ type: 'dictation.commit' });
    await until('commit', () =>
      session.commands.some((command) => command.type === 'input_audio.commit'),
    );
  });
});

describe('ending', () => {
  it('commits, waits for the open segment’s final text, then closes the session', async () => {
    const { session, client, disposed } = await ready();
    session.emit({
      type: 'transcript.interim',
      source: 'input_audio',
      itemId: 'item_1',
      contentIndex: 0,
      text: 'last wor',
    });
    await until('interim', () => types(client).includes('transcript.interim'));
    client.send({ type: 'dictation.end' });
    await until('commit', () =>
      session.commands.some((command) => command.type === 'input_audio.commit'),
    );
    expect(session.closed).toBe(false);
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'item_1',
      contentIndex: 0,
      transcript: 'last words',
    });
    await until('closed', () => client.closed !== null);
    expect(types(client).slice(-2)).toEqual(['transcript.final', 'dictation.closed']);
    expect(client.events.at(-1)).toEqual({ type: 'dictation.closed', reason: 'ended' });
    expect(client.closed?.code).toBe(1000);
    expect(session.closed).toBe(true);
    await until('disposed', () => disposed.mock.calls.length > 0);
  });

  it('waits a bounded time for a final that never comes', async () => {
    const { session, client } = await ready({ finalWaitMs: 50 });
    session.emit({
      type: 'transcript.interim',
      source: 'input_audio',
      itemId: 'item_1',
      contentIndex: 0,
      text: 'cut',
    });
    await until('interim', () => types(client).includes('transcript.interim'));
    client.send({ type: 'dictation.end' });
    await until('closed', () => client.closed !== null);
    expect(client.events.at(-1)).toEqual({ type: 'dictation.closed', reason: 'ended' });
    expect(types(client)).not.toContain('transcript.final');
  });

  it('ends with a typed error on a fatal Kaana error, keeping finals already sent', async () => {
    const { session, client } = await ready();
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'item_1',
      contentIndex: 0,
      transcript: 'kept',
    });
    session.emit({
      type: 'error',
      fatal: true,
      error: {
        schemaVersion: 1,
        code: 'rate_limited',
        message: 'slow down',
        retryable: true,
        requestId: session.requestId,
      },
    });
    await until('closed', () => client.closed !== null);
    expect(types(client).slice(1)).toEqual(['transcript.final', 'error', 'dictation.closed']);
    expect(client.events.at(-2)).toMatchObject({ code: 'TRANSCRIPTION_LIMITED', retryable: true });
    expect(client.events.at(-1)).toEqual({ type: 'dictation.closed', reason: 'error' });
  });

  it('closes the Kaana session when the device goes away', async () => {
    const { session, client } = await ready();
    client.ws.terminate();
    await until('upstream closed', () => session.closed);
  });

  it('never logs what was said', async () => {
    const { session, client } = await ready();
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'item_1',
      contentIndex: 0,
      transcript: 'secreto',
    });
    client.send({ type: 'dictation.end' });
    await until('closed', () => client.closed !== null);
    const calls = Object.values(quiet).flatMap((fn) => fn.mock.calls);
    // Positive control: the dictation's end is logged, so the log was read.
    expect(calls.some((call) => call.includes('Dictation closed'))).toBe(true);
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain('secreto');
  });
});
