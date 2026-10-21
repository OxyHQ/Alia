import http from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { oxyClient } from '../../middleware/auth.js';
import { callLocalTool, getLocalTools, mcpRelayRoute, shutdownMcpRelay } from '../mcp-relay.js';
import { routeWebSocketUpgrades } from '../websocket-upgrades.js';

/**
 * The relay's WebSocket handshake, driven end to end against a fake Oxy API.
 *
 * The subject is `validateToken`, and it is exercised through the REAL
 * entrypoint — an `http.Server`, the upgrade router with `mcpRelayRoute()` and a real `ws` client
 * sending `{type:'auth'}` — rather than by exporting the function. A relay that
 * validated perfectly and never called the validator would pass the direct
 * test.
 *
 * Nothing here stubs `@oxy.so/core`. The SDK's own `authSocket()` runs, and the
 * only thing replaced is `globalThis.fetch`, so what the assertions below
 * measure is the SDK's real session semantics rather than a mock's.
 *
 * ## Why the tokens are not signed
 *
 * They are `header.payload.not-a-signature`. That is not a shortcut: the SDK
 * decodes a user token WITHOUT verifying its signature and treats every claim
 * as attacker-controlled, deriving the identity from the server-validated
 * session instead. A test that signed its tokens would imply the signature is
 * what proves anything here, and it is not.
 */

/**
 * The user rows the fake `GET /session/validate-header/:id` resolves, keyed by
 * session id. The SDK (core 4.17+) validates a session WITH the bearer it was
 * handed, on the header lane, so Oxy also cross-checks the token against it.
 */
const sessions = new Map<string, { id: string }>();

/** Every URL `fetch` was called with, so a test can assert which endpoint ran. */
let fetchCalls: string[] = [];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The Oxy API, reduced to the one route the SDK's session validation calls.
 *
 * Everything else answers 404 — including `/me`, which is what the real
 * `api.oxy.so` answers for it (measured: `GET https://api.oxy.so/me` → 404
 * `NOT_FOUND`, against `GET /users/me` → 401 as the positive control). So a
 * relay that went back to asking `/me` would fail here for the same reason it
 * fails in production.
 */
function fakeOxyApi(input: string | URL): Promise<Response> {
  const url = String(input);
  fetchCalls.push(url);

  const match = /\/session\/validate-header\/([^?/]+)/.exec(url);
  if (!match) return Promise.resolve(jsonResponse({ error: 'NOT_FOUND' }, 404));

  const user = sessions.get(decodeURIComponent(match[1]));
  if (!user) {
    return Promise.resolve(jsonResponse({ valid: false }, 200));
  }
  return Promise.resolve(
    jsonResponse(
      {
        valid: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        lastActivity: new Date().toISOString(),
        user,
      },
      200,
    ),
  );
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function relayToken(claims: Record<string, unknown>): string {
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(claims)}.not-a-signature`;
}

let server: http.Server;
let port: number;
const openSockets: WebSocket[] = [];

/** Connect, send the `auth` message, and resolve with the relay's first reply. */
async function authenticate(
  token: string,
  targetPort = port,
): Promise<{ socket: WebSocket; reply: { type?: string } }> {
  const socket = new WebSocket(`ws://127.0.0.1:${targetPort}/ws/mcp`);
  openSockets.push(socket);

  const reply = await new Promise<{ type?: string }>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token })));
    socket.on('message', (data) => {
      const parsed: unknown = JSON.parse(data.toString());
      if (parsed !== null && typeof parsed === 'object') resolve(parsed);
    });
  });

  return { socket, reply };
}

const observeRelay = vi.fn();

beforeEach(async () => {
  observeRelay.mockClear();
  sessions.clear();
  // The SDK reuses a successful session validation on this process for 30 s
  // (core 6.1.0). The fake Oxy forgets its sessions per test, so the cache
  // does too: otherwise a test that asserts the round trip sees the previous
  // test's answer and no fetch at all.
  oxyClient.invalidateSessionValidations();
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(fakeOxyApi));

  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The relay test server did not bind a TCP port');
  }
  port = address.port;

  routeWebSocketUpgrades(server, {
    socketIoPath: '/socket.io',
    routes: [mcpRelayRoute(observeRelay)],
  });
});

afterEach(async () => {
  for (const socket of openSockets) socket.close();
  openSockets.length = 0;
  shutdownMcpRelay();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
});

describe('MCP relay authentication', () => {
  it('admits a session-bound token and keys the client by the session’s user', async () => {
    sessions.set('sess-1', { id: 'user-from-session' });

    const { socket, reply } = await authenticate(
      relayToken({ userId: 'user-from-session', sessionId: 'sess-1' }),
    );
    expect(reply.type).toBe('auth-ok');
    expect(observeRelay).toHaveBeenCalledTimes(1);
    expect(observeRelay.mock.calls[0][0]).toBeInstanceOf(WebSocket);
    expect(observeRelay.mock.calls[0][1]).toHaveProperty('upgrade', 'websocket');

    socket.send(
      JSON.stringify({
        type: 'register-tools',
        serverId: 'srv-1',
        serverName: 'Local',
        tools: [{ name: 'echo', description: 'echo', inputSchema: {} }],
      }),
    );

    await vi.waitFor(() => {
      expect(getLocalTools('user-from-session')).toHaveLength(1);
    });
  });

  it('validates the session through the SDK and never asks for /me', async () => {
    sessions.set('sess-1', { id: 'user-from-session' });

    const { reply } = await authenticate(
      relayToken({ userId: 'user-from-session', sessionId: 'sess-1' }),
    );

    expect(reply.type).toBe('auth-ok');
    expect(fetchCalls.some((url) => url.includes('/session/validate-header/sess-1'))).toBe(true);
    expect(fetchCalls.filter((url) => new URL(url).pathname === '/me')).toEqual([]);
  });

  /**
   * The load-bearing case. Session validation returns whoever owns the session
   * id it was handed (the unauthenticated `GET /session/validate/:id` did so
   * for any caller), so a caller holding any
   * live session id could pair it with a forged `userId` claim. The SDK
   * cross-checks the two and refuses; an implementation that read the claim
   * would admit `attacker`, and one that read the session blindly would admit
   * `victim`. Both are wrong, and only this assertion tells them apart.
   */
  it('refuses a live session paired with somebody else’s user claim', async () => {
    sessions.set('sess-victim', { id: 'victim' });

    const { reply } = await authenticate(
      relayToken({ userId: 'attacker', sessionId: 'sess-victim' }),
    );

    expect(reply.type).toBe('auth-error');
    expect(fetchCalls.some((url) => url.includes('/session/validate-header/sess-victim'))).toBe(
      true,
    );
    expect(getLocalTools('attacker')).toEqual([]);
    expect(getLocalTools('victim')).toEqual([]);
  });

  it('refuses a token that is bound to no session, without a round trip', async () => {
    const { reply } = await authenticate(relayToken({ userId: 'user-from-session' }));

    expect(reply.type).toBe('auth-error');
    expect(fetchCalls).toEqual([]);
  });

  it('refuses an expired token, without a round trip', async () => {
    sessions.set('sess-1', { id: 'user-from-session' });

    const { reply } = await authenticate(
      relayToken({
        userId: 'user-from-session',
        sessionId: 'sess-1',
        exp: Math.floor(Date.now() / 1000) - 60,
      }),
    );

    expect(reply.type).toBe('auth-error');
    expect(fetchCalls).toEqual([]);
  });

  it('refuses a token whose session the API does not recognise', async () => {
    const { reply } = await authenticate(
      relayToken({ userId: 'user-from-session', sessionId: 'sess-revoked' }),
    );

    expect(reply.type).toBe('auth-error');
    expect(fetchCalls.some((url) => url.includes('/session/validate-header/sess-revoked'))).toBe(
      true,
    );
  });

  it('refuses a token that is not a JWT at all', async () => {
    const { reply } = await authenticate('not-a-token');

    expect(reply.type).toBe('auth-error');
    expect(fetchCalls).toEqual([]);
  });

  it('refuses a retired alia_sk_ key, asking Oxy nothing', async () => {
    const { reply } = await authenticate('alia_sk_' + 'A1b2C3d4'.repeat(5));

    expect(reply.type).toBe('auth-error');
    expect(fetchCalls).toEqual([]);
  });
});

describe('MCP relay client lifecycle', () => {
  const registerEcho = (socket: WebSocket) =>
    socket.send(
      JSON.stringify({
        type: 'register-tools',
        serverId: 'srv-1',
        tools: [{ name: 'echo', description: 'echo', inputSchema: {} }],
      }),
    );

  it('keeps the new client when the replaced socket finishes closing', async () => {
    sessions.set('sess-1', { id: 'u1' });
    const token = relayToken({ userId: 'u1', sessionId: 'sess-1' });

    const first = await authenticate(token);
    const second = await authenticate(token);
    expect(second.reply.type).toBe('auth-ok');
    registerEcho(second.socket);
    await vi.waitFor(() => expect(getLocalTools('u1')).toHaveLength(1));

    await new Promise<void>((resolve) => {
      if (first.socket.readyState === WebSocket.CLOSED) resolve();
      else first.socket.on('close', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(getLocalTools('u1')).toHaveLength(1);
  });

  it('uses unguessable call ids and ignores results from another account', async () => {
    sessions.set('sess-a', { id: 'alice' });
    sessions.set('sess-b', { id: 'bob' });
    const alice = await authenticate(relayToken({ userId: 'alice', sessionId: 'sess-a' }));
    const bob = await authenticate(relayToken({ userId: 'bob', sessionId: 'sess-b' }));

    const received = new Promise<{ callId: string }>((resolve) => {
      alice.socket.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'tool-call') resolve(m);
      });
    });
    registerEcho(alice.socket);
    await vi.waitFor(() => expect(getLocalTools('alice')).toHaveLength(1));

    const call = callLocalTool('alice', 'srv-1', 'echo', {});
    const { callId } = await received;
    expect(callId).toMatch(/^[0-9a-f-]{36}$/);

    // Bob learns the id and tries to answer for Alice: ignored.
    bob.socket.send(JSON.stringify({ type: 'tool-result', callId, result: 'forged' }));
    await new Promise((r) => setTimeout(r, 30));
    alice.socket.send(JSON.stringify({ type: 'tool-result', callId, result: 'genuine' }));
    await expect(call).resolves.toBe('genuine');
  });
});

/**
 * The relay is idle between tool calls, and the ALB (60 s) and Cloudflare
 * (100 s) cut a connection that carries no bytes. The server pings; a peer that
 * misses one is terminated so its tools stop being offered.
 */
describe('MCP relay heartbeat', () => {
  const HEARTBEAT_MS = 40;
  let heartbeatServer: http.Server;
  let heartbeatPort: number;

  beforeEach(async () => {
    heartbeatServer = http.createServer();
    await new Promise<void>((resolve) => heartbeatServer.listen(0, '127.0.0.1', resolve));
    const address = heartbeatServer.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP port');
    heartbeatPort = address.port;
    routeWebSocketUpgrades(heartbeatServer, {
      socketIoPath: '/socket.io',
      routes: [mcpRelayRoute(undefined, { heartbeatIntervalMs: HEARTBEAT_MS })],
    });
  });

  afterEach(async () => {
    for (const socket of openSockets) socket.terminate();
    await new Promise<void>((resolve) => heartbeatServer.close(() => resolve()));
  });

  const registerEcho = (socket: WebSocket) =>
    socket.send(
      JSON.stringify({
        type: 'register-tools',
        serverId: 'srv-1',
        tools: [{ name: 'echo', description: 'echo', inputSchema: {} }],
      }),
    );

  it('pings an idle client and keeps it while it answers', async () => {
    sessions.set('sess-hb', { id: 'hb-live' });
    const { socket, reply } = await authenticate(
      relayToken({ userId: 'hb-live', sessionId: 'sess-hb' }),
      heartbeatPort,
    );
    expect(reply.type).toBe('auth-ok');
    let pings = 0;
    socket.on('ping', () => {
      pings += 1;
    });
    registerEcho(socket);
    await vi.waitFor(() => expect(getLocalTools('hb-live')).toHaveLength(1));

    await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 6));
    expect(pings).toBeGreaterThanOrEqual(3);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(getLocalTools('hb-live')).toHaveLength(1);
  });

  it('terminates a client that stops answering pings', async () => {
    sessions.set('sess-hb', { id: 'hb-dead' });
    const { socket } = await authenticate(
      relayToken({ userId: 'hb-dead', sessionId: 'sess-hb' }),
      heartbeatPort,
    );
    registerEcho(socket);
    await vi.waitFor(() => expect(getLocalTools('hb-dead')).toHaveLength(1));

    // Stop reading: pings reach the socket but are never answered, as with a
    // laptop that went to sleep or a network that silently dropped.
    socket.pause();
    await vi.waitFor(() => expect(getLocalTools('hb-dead')).toEqual([]), {
      timeout: HEARTBEAT_MS * 20,
    });
  });
});
