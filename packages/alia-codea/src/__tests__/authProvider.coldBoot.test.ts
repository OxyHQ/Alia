import { afterEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { computeCodeChallenge } from '@oxy.so/core';
import { createNativeAuthStateStore } from '@oxy.so/core/session';
import { AliaAuthenticationProvider } from '../authProvider';
const providers: AliaAuthenticationProvider[] = [];
afterEach(() => {
  for (const provider of providers.splice(0)) provider.dispose();
  vi.restoreAllMocks();
});
function fixture() {
  const data = new Map<string, string>();
  const storage = {
    getItem: async (k: string) => data.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: async (k: string) => {
      data.delete(k);
    },
  };
  const secrets = {
    get: async (k: string) => data.get(k),
    store: storage.setItem,
    delete: storage.removeItem,
    onDidChange: () => ({ dispose() {} }),
  };
  const context = { secrets } as unknown as ExtensionContext;
  const create = () => {
    const provider = new AliaAuthenticationProvider(context);
    providers.push(provider);
    vi.spyOn(provider.getOxyServices().users, 'me').mockRejectedValue(
      new Error('Offline display lookup'),
    );
    return provider;
  };
  return {
    data,
    store: createNativeAuthStateStore(storage),
    loadFresh: () => createNativeAuthStateStore(storage).load(),
    create,
  };
}
it('display metadata cannot restore a session without the shared device store', async () => {
  const f = fixture();
  f.data.set(
    'alia.session.v1',
    JSON.stringify({
      userId: 'stale-account',
      username: 'Old',
      accessToken: 'old-token',
      expiresAt: '2099-01-01T00:00:00Z',
    }),
  );
  const provider = f.create();
  expect(await provider.getSessions()).toEqual([]);
  expect(provider.getOxyServices().session.accessToken).toBeNull();
});
it('shared warm restore selects its own account and sign-out clears its durable credential', async () => {
  const f = fixture();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `e30.${Buffer.from(JSON.stringify({ userId: 'actual-account', sessionId: 'actual-session', exp })).toString('base64url')}.signature`;
  await f.store.save({
    userId: 'actual-account',
    sessionId: 'actual-session',
    deviceId: 'device-test',
    deviceSecret: 'test-secret',
    accessToken: token,
    expiresAt: new Date(exp * 1000).toISOString(),
  });
  f.data.set(
    'alia.session.v1',
    JSON.stringify({ userId: 'other-account', username: 'Other private display name' }),
  );
  const provider = f.create();
  const sessions = await provider.getSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0].account.id).toBe('actual-account');
  expect(sessions[0].account.label).not.toBe('Other private display name');
  await provider.removeSession(sessions[0].id);
  expect(await f.loadFresh()).toBeNull();
  expect(provider.getOxyServices().session.accessToken).toBeNull();
});

it('uses shared PKCE without scopes and persists the exchanged account rather than token guesses', async () => {
  const f = fixture();
  const provider = f.create();
  await provider.getSessions();
  const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
  const exchange = vi
    .spyOn(provider.getOxyServices().auth.oauth, 'exchangeCode')
    .mockResolvedValue({
      sessionId: 'session-own',
      deviceId: 'device-own',
      deviceSecret: 'device-secret',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      accessToken: 'opaque-access-token',
      user: { id: 'account-from-exchange', username: 'Own account' },
    });
  const signingIn = provider.signInWithBrowser();
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  const authorize = new URL(open.mock.calls[0][0].toString());
  expect(authorize.searchParams.has('scope')).toBe(false);
  await provider.handleUri({
    path: '/auth-callback',
    query: new URLSearchParams({
      code: 'own-code',
      state: authorize.searchParams.get('state') ?? '',
    }).toString(),
  } as vscode.Uri);
  const session = await signingIn;
  expect(session.account.id).toBe('account-from-exchange');
  expect(session.scopes).toEqual([]);
  expect(await computeCodeChallenge(exchange.mock.calls[0][0].codeVerifier ?? '')).toBe(
    authorize.searchParams.get('code_challenge'),
  );
  expect(await f.loadFresh()).toMatchObject({
    userId: 'account-from-exchange',
    deviceId: 'device-own',
  });
  provider.getOxyServices().session.setAccessToken('rotated-token');
  expect((await provider.getSessions())[0].accessToken).toBe('rotated-token');
  await provider.removeSession(session.id);
});
