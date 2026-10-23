import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Kaana } from '@kaana.ai/sdk';
import { OxyServer } from '@oxy.so/core/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ client: null as OxyServer | null }));
vi.mock('../../oxy-service-client.js', () => ({ oxyServiceClient: () => H.client }));
const { getKaanaClient, setKaanaClientForTests } = await import('../transport.js');
let issuer: Server;
let baseURL: string;
let mints: Record<string, unknown>[] = [];
const token = `e30.${Buffer.from(JSON.stringify({ authority: 'first_party', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.fixture`;

beforeAll(async () => {
  issuer = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/challenge')) return res.end(JSON.stringify({ nonce: 'fixture' }));
    let body = '';
    for await (const chunk of req) body += chunk;
    mints.push(JSON.parse(body));
    res.end(JSON.stringify({ token, expiresIn: 300 }));
  });
  await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      issuer.close((error) => (error ? reject(error) : resolve())),
    ),
);
beforeEach(() => {
  mints = [];
  setKaanaClientForTests(undefined);
  H.client = new OxyServer({
    baseURL,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'fixture',
      Token: 'temporary',
    }),
  });
});
afterEach(() => {
  H.client?.dispose();
  H.client = null;
  setKaanaClientForTests(undefined);
  vi.unstubAllGlobals();
});

describe('getKaanaClient', () => {
  it('keeps attribution per call and shares the real v2 workload mint across callers', async () => {
    const nativeFetch = globalThis.fetch;
    const observed: Array<{ account: string | null; authorization: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.origin !== 'https://kaana.ai') return nativeFetch(input, init);
        const headers = new Headers(init?.headers);
        observed.push({
          account: headers.get('x-oxy-user-id'),
          authorization: headers.get('authorization'),
        });
        return Response.json({ data: [] }, { headers: { 'Kaana-Request-Id': 'fixture-request' } });
      },
    );
    const a = getKaanaClient('A');
    const b = getKaanaClient('B');
    expect(a).toBeInstanceOf(Kaana);
    try {
      await a!.models.list({ onBehalfOfUserId: 'A' });
      await b!.models.list({ onBehalfOfUserId: 'B' });
      await expect(a!.models.list({ onBehalfOfUserId: 'B' })).rejects.toThrow();
      expect(observed).toEqual([
        { account: 'A', authorization: `Bearer ${token}` },
        { account: 'B', authorization: `Bearer ${token}` },
      ]);
      expect(mints).toHaveLength(1);
      expect(mints[0]).toMatchObject({ audience: 'kaana.ai', protocolVersion: 2 });
      expect(mints[0]).not.toHaveProperty('scopes');
      a!.dispose?.();
      await expect(a!.models.list()).rejects.toThrow();
    } finally {
      a?.dispose?.();
      b?.dispose?.();
    }
  });
  it('reports missing configured workload identity without a substitute credential', () => {
    H.client?.dispose();
    H.client = null;
    expect(getKaanaClient('A')).toBeNull();
  });
});
