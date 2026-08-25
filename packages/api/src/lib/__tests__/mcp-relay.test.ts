import http from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashDeveloperApiKey } from '../api-key-crypto.js';
import { getLocalTools, initMcpRelay, shutdownMcpRelay } from '../mcp-relay.js';

/**
 * The `alia_sk_*` lane resolves against Alia's OWN database, so its store is
 * the one thing here that has to be stubbed. It is an Alia credential, not an
 * Oxy one, and this suite exists partly to hold that distinction still.
 */
const apiKeyRows = new Map<string, { oxyUserId: string }>();

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../db/developers/developerRepository.js', () => ({
  findActiveKeyByHash: vi.fn((_db: unknown, keyHash: string) => apiKeyRows.get(keyHash) ?? null),
}));

/**
 * The relay's WebSocket handshake, driven end to end against a fake Oxy API.
 *
 * The subject is `validateToken`, and it is exercised through the REAL
 * entrypoint — an `http.Server`, `initMcpRelay()` and a real `ws` client
 * sending `{type:'auth'}` — rather than by exporting the function. A relay that
 * validated perfectly and never called the validator would pass the direct
 * test.
 *
 * Nothing here stubs `@oxyhq/core`. The SDK's own `authSocket()` runs, and the
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

/** The user rows the fake `GET /session/validate/:id` resolves, keyed by session id. */
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

  const match = /\/session\/validate\/([^?/]+)/.exec(url);
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
async function authenticate(token: string): Promise<{ socket: WebSocket; reply: { type?: string } }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/mcp`);
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

beforeEach(async () => {
  sessions.clear();
  apiKeyRows.clear();
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(fakeOxyApi));

  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The relay test server did not bind a TCP port');
  }
  port = address.port;

  initMcpRelay(server);
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
    expect(fetchCalls.some((url) => url.includes('/session/validate/sess-1'))).toBe(true);
    expect(fetchCalls.filter((url) => new URL(url).pathname === '/me')).toEqual([]);
  });

  /**
   * The load-bearing case. `GET /session/validate/:id` is UNAUTHENTICATED and
   * returns whoever owns the session id it was handed, so a caller holding any
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
    expect(fetchCalls.some((url) => url.includes('/session/validate/sess-victim'))).toBe(true);
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
    expect(fetchCalls.some((url) => url.includes('/session/validate/sess-revoked'))).toBe(true);
  });

  it('refuses a token that is not a JWT at all', async () => {
    const { reply } = await authenticate('not-a-token');

    expect(reply.type).toBe('auth-error');
    expect(fetchCalls).toEqual([]);
  });

  it('still resolves an alia_sk_ key against Alia’s own store, asking Oxy nothing', async () => {
    apiKeyRows.set(hashDeveloperApiKey('alia_sk_live'), { oxyUserId: 'key-owner' });

    const { socket, reply } = await authenticate('alia_sk_live');
    expect(reply.type).toBe('auth-ok');
    expect(fetchCalls).toEqual([]);

    socket.send(
      JSON.stringify({
        type: 'register-tools',
        serverId: 'srv-1',
        serverName: 'Local',
        tools: [{ name: 'echo', description: 'echo', inputSchema: {} }],
      }),
    );

    await vi.waitFor(() => {
      expect(getLocalTools('key-owner')).toHaveLength(1);
    });
  });

  it('refuses an alia_sk_ key with no active row', async () => {
    const { reply } = await authenticate('alia_sk_revoked');

    expect(reply.type).toBe('auth-error');
    expect(fetchCalls).toEqual([]);
  });
});
