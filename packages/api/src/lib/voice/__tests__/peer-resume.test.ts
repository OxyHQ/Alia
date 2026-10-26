import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { VoiceCall } from '../call.js';
import type { VoiceRoute, VoiceRouting } from '../routing-directory.js';

vi.mock('../../logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});
vi.mock('../environment.js', () => ({ createVoiceEnvironment: vi.fn() }));
vi.mock('../../socket-session-auth.js', () => ({ authenticateSocketSession: vi.fn() }));
vi.mock('../../app-surface.js', () => ({ verifySurface: vi.fn(async () => null) }));

const { voiceSessionRoute, voiceResumePeerRoute } = await import('../voice-socket.js');
const { routeWebSocketUpgrades } = await import('../../websocket-upgrades.js');
const { harness, until, pcmBase64 } = await import('./support.js');
const sockets = new Set<WebSocket>();
const servers: http.Server[] = [];
const calls: VoiceCall[] = [];
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await Promise.all(calls.splice(0).map((call) => call.end('hangup')));
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

async function cluster() {
  const h = harness();
  const entries = new Map<string, VoiceRoute & { port: number }>();
  const make = async () => {
    const server = http.createServer();
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    const generation = randomUUID();
    const held = new Map<string, VoiceCall>();
    const routing: VoiceRouting = {
      generation,
      find: vi.fn(async (id, owner) => {
        const value = entries.get(id);
        return value && value.accountId === owner && value.expiresAt > Date.now() ? value : null;
      }),
      register: vi.fn(async (id, owner) => {
        const value = {
          accountId: owner,
          generation,
          address: '127.0.0.1',
          port,
          expiresAt: Date.now() + 30_000,
        };
        entries.set(id, value);
        return {
          release: async () => {
            if (entries.get(id) === value) entries.delete(id);
          },
        };
      }),
      peerUrl: (route) =>
        `ws://127.0.0.1:${(route as VoiceRoute & { port: number }).port}/internal/voice/relay`,
      permitsPeer: (address, host) => address === '127.0.0.1' && host === `127.0.0.1:${port}`,
    };
    const authenticate = vi.fn(async (token: string) =>
      token === 'human-A'
        ? { userId: 'account-A', sessionId: 'session-A' }
        : token === 'human-B'
          ? { userId: 'account-B', sessionId: 'session-B' }
          : null,
    );
    const peerAuth = {
      token: vi.fn(async () => 'own-api-workload'),
      verify: vi.fn(async (token: string) => token === 'own-api-workload'),
    };
    const options = {
      environment: () => h.env,
      authenticate,
      surface: async () => null,
      calls: held,
      routing: async () => routing,
      peerAuth,
    };
    routeWebSocketUpgrades(server, {
      socketIoPath: '/socket.io',
      routes: [
        voiceSessionRoute((socket) => sockets.add(socket), options),
        voiceResumePeerRoute(options),
      ],
    });
    return { url: `ws://127.0.0.1:${port}`, held, routing, authenticate, peerAuth };
  };
  const a = await make();
  const b = await make();
  return { a, b, h, entries };
}

async function connect(url: string, token = 'human-A') {
  const ws = new WebSocket(`${url}/v1/voice/session`);
  sockets.add(ws);
  const events: Record<string, unknown>[] = [];
  const audio: Buffer[] = [];
  let closed = false;
  ws.on('message', (value, binary) =>
    binary ? audio.push(value as Buffer) : events.push(JSON.parse(value.toString())),
  );
  ws.on('error', () => {});
  ws.on('close', () => {
    closed = true;
  });
  await new Promise<void>((done, reject) => {
    ws.once('open', done);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token }));
  await until('authenticated', () => events.some((event) => event.type === 'auth.ok') || closed);
  return {
    ws,
    events,
    audio,
    closed: () => closed,
    send: (value: unknown) => ws.send(JSON.stringify(value)),
  };
}

async function start(c: Awaited<ReturnType<typeof cluster>>) {
  const client = await connect(c.a.url);
  client.send({
    type: 'session.start',
    protocol: 2,
    conversationId: 'conv-A',
    voice: 'female',
    locale: 'es-ES',
  });
  await until('ready', () => client.events.some((event) => event.type === 'session.ready'));
  const id = String(
    client.events.find((event) => event.type === 'session.accepted')?.voiceSessionId,
  );
  const seq = Number(client.events.at(-1)?.seq);
  const call = c.a.held.get(id);
  if (call) calls.push(call);
  client.ws.terminate();
  await until('disconnected', client.closed);
  return { id, seq };
}

describe('cookie-free resume through another task', () => {
  it('reattaches the original call with replay/audio and one admission and settlement', async () => {
    const c = await cluster();
    const started = await start(c);
    c.h.session().emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    await new Promise((done) => setTimeout(done, 10));
    const resumed = await connect(c.b.url);
    resumed.send({
      type: 'session.resume',
      protocol: 2,
      voiceSessionId: started.id,
      afterSeq: started.seq,
    });
    await until('cross-node replay', () =>
      resumed.events.some((event) => event.type === 'session.resumed'),
    );
    expect(resumed.events.map((event) => event.type)).toEqual([
      'auth.ok',
      'user.speech_started',
      'session.resumed',
    ]);
    expect(c.a.authenticate).toHaveBeenCalledTimes(2); // original and owner's pure resume verification
    expect(c.b.authenticate).toHaveBeenCalledTimes(1);
    expect(c.h.server.sessions).toHaveLength(1);
    expect(c.h.startCall).toHaveBeenCalledTimes(1);
    c.h.session().emit({
      type: 'output_audio.delta',
      responseId: 'r1',
      itemId: 'a1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });
    await until('relayed audio', () => resumed.audio.length === 1);
    resumed.send({ type: 'session.end' });
    await until('closed', resumed.closed);
    await until('settled once', () => c.h.finishCall.mock.calls.length === 1);
    expect(c.h.finishCall).toHaveBeenCalledTimes(1);
    expect(c.h.server.sessions).toHaveLength(1);
    await until('directory removed', () => c.entries.size === 0);
  });

  it.each([
    'wrong-account',
    'expired-route',
    'recycled-address',
    'wrong-workload',
    'lost-owner',
  ] as const)(
    'refuses %s without opening another call or forwarding a human proof to a different instance',
    async (failure) => {
      const c = await cluster();
      const started = await start(c);
      const route = c.entries.get(started.id)!;
      if (failure === 'expired-route') route.expiresAt = Date.now() - 1;
      if (failure === 'recycled-address') route.generation = randomUUID();
      if (failure === 'wrong-workload') c.b.peerAuth.token.mockResolvedValue('external-key');
      if (failure === 'lost-owner') c.a.held.delete(started.id);
      const client = await connect(c.b.url, failure === 'wrong-account' ? 'human-B' : 'human-A');
      client.send({
        type: 'session.resume',
        protocol: 2,
        voiceSessionId: started.id,
        afterSeq: started.seq,
      });
      await until('refused', client.closed);
      expect(client.events.at(-1)).toMatchObject({ type: 'error', code: 'resume-unavailable' });
      expect(c.h.server.sessions).toHaveLength(1);
      if (failure === 'recycled-address') expect(c.b.peerAuth.token).not.toHaveBeenCalled();
      if (failure !== 'lost-owner') expect(c.a.authenticate).toHaveBeenCalledTimes(1);
    },
  );

  it('replaces a relayed holder without a second admission or a stale close detaching its successor', async () => {
    const c = await cluster();
    const started = await start(c);
    const first = await connect(c.b.url);
    first.send({
      type: 'session.resume',
      protocol: 2,
      voiceSessionId: started.id,
      afterSeq: started.seq,
    });
    await until('first resumed', () =>
      first.events.some((event) => event.type === 'session.resumed'),
    );
    const next = await connect(c.a.url);
    next.send({
      type: 'session.resume',
      protocol: 2,
      voiceSessionId: started.id,
      afterSeq: started.seq,
    });
    await until('next resumed', () =>
      next.events.some((event) => event.type === 'session.resumed'),
    );
    await until('old relay closed', first.closed);
    c.h.session().emit({
      type: 'output_audio.delta',
      responseId: 'r1',
      itemId: 'a1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });
    await until('new holder audio', () => next.audio.length === 1);
    expect(c.h.startCall).toHaveBeenCalledTimes(1);
    expect(c.h.finishCall).not.toHaveBeenCalled();
    next.send({ type: 'session.end' });
    await until('ended once', () => c.h.finishCall.mock.calls.length === 1);
  });

  it('rejects ALB/public forwarded ingress before its opaque greeting', async () => {
    const c = await cluster();
    const ws = new WebSocket(`${c.a.url}/internal/voice/relay`, {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    sockets.add(ws);
    let frames = 0;
    ws.on('message', () => frames++);
    ws.on('error', () => {});
    const status = await new Promise<number>((done) =>
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        done(response.statusCode ?? 0);
        ws.terminate();
      }),
    );
    expect(status).toBe(403);
    expect(frames).toBe(0);
    expect(c.a.peerAuth.verify).not.toHaveBeenCalled();
  });

  it('cannot open a new call over the private resume-only path, even with valid workload and human proofs', async () => {
    const c = await cluster();
    const ws = new WebSocket(`${c.a.url}/internal/voice/relay`);
    sockets.add(ws);
    const events: Record<string, unknown>[] = [];
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      events.push(event);
      if (event.type === 'alia.voice.peer')
        ws.send(JSON.stringify({ type: 'alia.voice.peer.auth', token: 'own-api-workload' }));
      if (event.type === 'alia.voice.peer.ready')
        ws.send(JSON.stringify({ type: 'auth', token: 'human-A' }));
      if (event.type === 'auth.ok')
        ws.send(
          JSON.stringify({
            type: 'session.start',
            protocol: 2,
            conversationId: 'conv-A',
            voice: 'female',
            locale: 'es-ES',
          }),
        );
    });
    await new Promise<void>((done) => ws.once('close', () => done()));
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'invalid-request' });
    expect(c.h.startCall).not.toHaveBeenCalled();
    expect(c.h.server.sessions).toHaveLength(0);
  });

  it('cancels a pending peer handshake when the person disconnects without forwarding their proof', async () => {
    const c = await cluster();
    const started = await start(c);
    let mintSignal: AbortSignal | undefined;
    c.b.peerAuth.token.mockImplementation(async (...args: unknown[]) => {
      mintSignal = args[1] as AbortSignal;
      return new Promise<string>((_resolve, reject) =>
        mintSignal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      );
    });
    const resumed = await connect(c.b.url);
    resumed.send({
      type: 'session.resume',
      protocol: 2,
      voiceSessionId: started.id,
      afterSeq: started.seq,
    });
    await until('mint waiting', () => Boolean(mintSignal));
    resumed.ws.terminate();
    await until('mint cancelled', () => mintSignal?.aborted === true);
    expect(c.a.authenticate).toHaveBeenCalledTimes(1);
    expect(c.a.peerAuth.verify).not.toHaveBeenCalled();
    expect(c.h.startCall).toHaveBeenCalledTimes(1);
  });
});
