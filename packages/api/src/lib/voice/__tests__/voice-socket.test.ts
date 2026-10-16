import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.mock('../../logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});
// The socket's default environment is never built here: every server gets the harness's.
vi.mock('../environment.js', () => ({ createVoiceEnvironment: vi.fn() }));
vi.mock('../../socket-session-auth.js', () => ({ authenticateSocketToken: vi.fn() }));

const { log } = await import('../../logger.js');
const { initVoiceSessions } = await import('../voice-socket.js');
const { decodeAssistantAudioFrame, VOICE_SESSION_PATH } = await import('../protocol.js');
const { harness, pcmBase64, until } = await import('./support.js');

/**
 * `GET /v1/voice/session` over a real socket (ADR 0017 §1, §3): who may call,
 * the opening handshake, audio both ways, and what the device can ever see.
 */

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function serve(env = harness().env) {
  const server = http.createServer();
  servers.push(server);
  initVoiceSessions(server, undefined, {
    environment: () => env,
    authenticate: async (token) => (token === 'good-token' ? 'user-1' : null),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}${VOICE_SESSION_PATH}`;
}

interface Client {
  ws: WebSocket;
  events: Array<Record<string, unknown>>;
  audio: Uint8Array[];
  closed: { code: number } | null;
  send(event: unknown): void;
}

async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  const client: Client = {
    ws,
    events: [],
    audio: [],
    closed: null,
    send: (event) => ws.send(JSON.stringify(event)),
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) client.audio.push(new Uint8Array(data as Buffer));
    else client.events.push(JSON.parse(data.toString()));
  });
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

describe('who may call', () => {
  it('refuses an oxy_sk_ machine credential with credential-not-supported', async () => {
    const client = await connect(await serve());
    client.send({ type: 'auth', token: 'oxy_sk_live_abc' });
    await until('closed', () => client.closed !== null);
    expect(client.events[0]).toMatchObject({ type: 'error', code: 'credential-not-supported' });
    expect(client.closed?.code).toBe(4003);
  });

  it('refuses a token Oxy does not validate, and a session.start before auth', async () => {
    const bad = await connect(await serve());
    bad.send({ type: 'auth', token: 'bad-token' });
    await until('closed', () => bad.closed !== null);
    expect(bad.events[0]).toMatchObject({ type: 'error', code: 'not-authenticated' });

    const early = await connect(await serve());
    early.send({
      type: 'session.start',
      protocol: 1,
      conversationId: 'c1',
      voice: 'female',
      locale: 'es-ES',
    });
    await until('closed', () => early.closed !== null);
    expect(early.events[0]).toMatchObject({ type: 'error', code: 'not-authenticated' });
  });

  it('refuses another protocol version', async () => {
    const client = await connect(await serve());
    client.send({ type: 'auth', token: 'good-token' });
    await until('auth.ok', () => types(client).includes('auth.ok'));
    client.send({
      type: 'session.start',
      protocol: 2,
      conversationId: 'c1',
      voice: 'female',
      locale: 'es-ES',
    });
    await until('closed', () => client.closed !== null);
    expect(client.events.at(-1)).toMatchObject({ type: 'error', code: 'invalid-request' });
  });
});

describe('a call over the socket', () => {
  it('opens, carries audio both ways, and never sends a schema, an instruction or a tool result', async () => {
    const h = harness();
    const client = await connect(await serve(h.env));
    client.send({ type: 'auth', token: 'good-token' });
    await until('auth.ok', () => types(client).includes('auth.ok'));
    client.send({
      type: 'session.start',
      protocol: 1,
      conversationId: 'conv-1',
      voice: 'female',
      locale: 'es-ES',
    });
    await until('ready', () => types(client).includes('session.ready'));
    expect(types(client).slice(0, 3)).toEqual(['auth.ok', 'session.accepted', 'session.ready']);

    // Microphone audio reaches the upstream session; the first append is acknowledged.
    client.ws.send(new Uint8Array(1920), { binary: true });
    await until('input.ready', () => types(client).includes('input.ready'));
    const session = h.kaana!.session;
    expect(session.appendedBytes).toBe(1920);

    // A tool round trip and a spoken answer.
    session.emit({
      type: 'tool_call',
      responseId: 'r1',
      itemId: 'f1',
      toolCallId: 'c1',
      name: 'lookupWeather',
      argumentsDelta: '{"city":"Lisboa"}',
      complete: true,
    });
    await until('tool.finished', () => types(client).includes('tool.finished'));
    session.emit({
      type: 'output_audio.delta',
      responseId: 'r2',
      itemId: 'a1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });
    await until('audio', () => client.audio.length === 1);
    const frame = decodeAssistantAudioFrame(client.audio[0]!);
    expect(frame?.itemId).toBe('a1');
    expect(frame?.pcm.byteLength).toBe(1920);

    const seen = JSON.stringify(client.events);
    expect(seen).not.toContain('INSTRUCTIONS');
    expect(seen).not.toContain('Lisboa');
    expect(seen).not.toContain('celsius');
    expect(seen).not.toContain('"properties"');
    for (const event of client.events.slice(1)) expect(typeof event.seq).toBe('number');

    client.send({ type: 'session.end' });
    await until('closed', () => client.closed !== null);
    expect(client.events.at(-1)).toMatchObject({ type: 'session.closed', reason: 'hangup' });
    expect(session.closeCount).toBe(1);
  });

  it('resumes a dropped socket on the same call and replays what it missed', async () => {
    const h = harness();
    const url = await serve(h.env);
    const first = await connect(url);
    first.send({ type: 'auth', token: 'good-token' });
    await until('auth.ok', () => types(first).includes('auth.ok'));
    first.send({
      type: 'session.start',
      protocol: 1,
      conversationId: 'conv-1',
      voice: 'female',
      locale: 'es-ES',
    });
    await until('ready', () => types(first).includes('session.ready'));
    const accepted = first.events.find((event) => event.type === 'session.accepted')!;
    const lastSeq = Number(first.events.at(-1)!.seq);
    first.ws.terminate();
    await until('closed', () => first.closed !== null);
    // The drop is logged with its close code: the one trace a device's drop leaves.
    await until('drop logged', () =>
      vi
        .mocked(log.voice.warn)
        .mock.calls.some(([, message]) => message === 'Voice socket dropped'),
    );
    expect(vi.mocked(log.voice.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        closeCode: 1006,
        closedHere: false,
        callId: expect.stringMatching(/^vc_/),
      }),
      'Voice socket dropped',
    );
    h.kaana!.session.emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await connect(url);
    second.send({ type: 'auth', token: 'good-token' });
    await until('auth.ok', () => types(second).includes('auth.ok'));
    second.send({
      type: 'session.resume',
      protocol: 1,
      voiceSessionId: accepted.voiceSessionId,
      afterSeq: lastSeq,
    });
    await until('resumed', () => types(second).includes('session.resumed'));
    expect(types(second)).toEqual(['auth.ok', 'user.speech_started', 'session.resumed']);
    expect(h.kaana!.sessions).toHaveLength(1);
    second.send({ type: 'session.end' });
    await until('closed', () => second.closed !== null);
  });

  it('answers resume-unavailable for a call this task does not hold', async () => {
    const client = await connect(await serve());
    client.send({ type: 'auth', token: 'good-token' });
    await until('auth.ok', () => types(client).includes('auth.ok'));
    client.send({ type: 'session.resume', protocol: 1, voiceSessionId: 'vs_unknown', afterSeq: 3 });
    await until('closed', () => client.closed !== null);
    expect(client.events.at(-1)).toMatchObject({ type: 'error', code: 'resume-unavailable' });
  });
});
