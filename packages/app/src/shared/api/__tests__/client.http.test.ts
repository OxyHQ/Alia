import { test, vi } from 'vitest';
const config = vi.hoisted(() => ({ apiUrl: '' }));
vi.mock('@/shared/platform/config', () => ({ default: config }));
import assert from 'node:assert/strict';
import { isAxiosError } from 'axios';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';

test('real Axios/shared HTTP isolates anonymous, signed-in, switched and disposed sessions', async () => {
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  const token = (userId: string, exp = 2_000_000_000) =>
    `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, exp })).toString('base64url')}.fixture`;
  let refreshedRequests = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/private' });
      res.end();
      return;
    }
    if (req.url === '/refresh' && ++refreshedRequests === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url === '/held') {
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      arrived?.();
      await ready;
    }
    res.writeHead(req.url === '/private' && !req.headers.authorization ? 401 : 200, {
      'content-type': 'application/json',
    });
    res.end(
      JSON.stringify({
        bearer: req.headers.authorization ?? null,
        cookie: req.headers.cookie ?? null,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.apiUrl = origin;
  const api = await import('../client');
  const { createApiSocketSession } = await import('../socket-session');
  const oxy = new OxyServices({ baseURL: origin });
  api.bindApiClient(oxy);
  try {
    const response = await api.default.get('/public', {
      headers: { Authorization: 'Bearer forged', Cookie: 'ambient=1' },
    });
    assert.deepEqual(response.data, { bearer: null, cookie: null });
    await assert.rejects(
      api.default.get('/private'),
      (error: unknown) => isAxiosError(error) && error.response?.status === 401,
    );
    oxy.session.setAccessToken(token('A', 1));
    oxy.http.setAuthRefreshHandler(async () => token('A'));
    assert.equal(await api.socketAccessToken(new AbortController().signal), token('A'));
    assert.equal(api.hasApiSession(), true);
    assert.equal((await api.default.get('/private')).data.bearer, `Bearer ${token('A')}`);
    let refreshes = 0;
    oxy.http.setAuthRefreshHandler(async () => {
      refreshes++;
      return token('A', 2_000_000_001);
    });
    assert.equal(
      (await api.default.get('/refresh')).data.bearer,
      `Bearer ${token('A', 2_000_000_001)}`,
    );
    assert.equal(refreshedRequests, 2);
    assert.equal(refreshes, 1);
    await assert.rejects(api.default.get('/redirect'));
    await assert.rejects(api.default.get('http://127.0.0.1:1/private'));
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(api.default.get('/private', { signal: aborted.signal }));
    const socketSession = createApiSocketSession();
    const disconnect = vi.fn();
    socketSession.bind({ disconnect } as never);
    let handshakeToken: string | undefined;
    await new Promise<void>((resolve) =>
      socketSession.auth((value) => {
        handshakeToken = value.token;
        resolve();
      }),
    );
    assert.equal(handshakeToken, token('A', 2_000_000_001));
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const pending = api.default.get('/held');
    await ready;
    oxy.session.setAccessToken(token('B'));
    assert.equal(disconnect.mock.calls.length, 1);
    assert.equal(socketSession.signal.aborted, true);
    let staleCallback = false;
    socketSession.auth(() => {
      staleCallback = true;
    });
    await Promise.resolve();
    assert.equal(staleCallback, false);
    socketSession.dispose();
    release?.();
    await assert.rejects(pending, { code: 'AUTH_SESSION_CHANGED' });
    assert.equal((await api.default.get('/private')).data.bearer, `Bearer ${token('B')}`);
    let changes = 0;
    const unsubscribe = api.onApiSessionContextChange(() => {
      changes++;
    });
    oxy.session.clear();
    assert.equal(changes, 1);
    assert.equal(api.hasApiSession(), false);
    await assert.rejects(api.socketAccessToken(new AbortController().signal), /active Oxy session/);
    unsubscribe();
    api.releaseApiClient(oxy);
    await assert.rejects(api.default.get('/public'), /provider has not bound/);
    api.bindApiClient(oxy);
    assert.equal((await api.default.get('/public')).data.bearer, null);
    api.releaseApiClient(oxy);
  } finally {
    release?.();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('a pending socket refresh cannot authenticate the previous account after switching', async () => {
  const api = await import('../client');
  const { createApiSocketSession } = await import('../socket-session');
  const token = (id: string, exp: number) =>
    `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId: id, exp })).toString('base64url')}.fixture`;
  const oxy = new OxyServices({ baseURL: config.apiUrl });
  oxy.session.setAccessToken(token('A', 1));
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  oxy.http.setAuthRefreshHandler(async () => {
    arrived?.();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return token('A', 2_000_000_000);
  });
  api.bindApiClient(oxy);
  const session = createApiSocketSession();
  const disconnect = vi.fn();
  session.bind({ disconnect } as never);
  const callback = vi.fn();
  try {
    session.auth(callback);
    await ready;
    oxy.session.setAccessToken(token('B', 2_000_000_000));
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(callback.mock.calls.length, 0);
    assert.equal(disconnect.mock.calls.length, 1);
    assert.equal(oxy.session.userId, 'B');
  } finally {
    release?.();
    session.dispose();
    api.releaseApiClient(oxy);
    oxy.dispose();
  }
});
