import { Kaana } from '@kaana.ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  canAuthenticate: true,
  tokenFor: vi.fn(async (audience: string) => `token-for-${audience}`),
}));

vi.mock('../../oxy-service-client.js', () => ({
  canAuthenticateAsOxyService: () => H.canAuthenticate,
  oxyServiceTokenFor: H.tokenFor,
}));

const { getKaanaClient, setKaanaClientForTests, KAANA_SERVICE_TOKEN_AUDIENCE } = await import(
  '../transport.js'
);
const { FakeKaana } = await import('../fake.js');

const production = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

describe('getKaanaClient', () => {
  beforeEach(() => {
    setKaanaClientForTests(undefined);
    H.canAuthenticate = true;
    H.tokenFor.mockClear();
  });
  afterEach(() => {
    setKaanaClientForTests(undefined);
    vi.unstubAllGlobals();
  });

  it('builds the real SDK client when the process has an Oxy service identity', () => {
    expect(getKaanaClient(production)).toBeInstanceOf(Kaana);
  });

  it('has no client, never a stand-in, when the process has no Oxy service identity', () => {
    H.canAuthenticate = false;
    expect(getKaanaClient(production)).toBeNull();
  });

  it('presents a service token minted for kaana.ai, asked for on every request', async () => {
    const authorizations: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        authorizations.push(new Headers(init.headers).get('authorization'));
        return new Response(JSON.stringify({ object: 'list', data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
        });
      }),
    );
    const client = getKaanaClient(production);
    await client?.models.list().catch(() => undefined);
    await client?.models.list().catch(() => undefined);

    expect(KAANA_SERVICE_TOKEN_AUDIENCE).toBe('kaana.ai');
    expect(H.tokenFor).toHaveBeenCalledTimes(2);
    expect(H.tokenFor).toHaveBeenCalledWith('kaana.ai');
    expect(authorizations).toEqual(['Bearer token-for-kaana.ai', 'Bearer token-for-kaana.ai']);
  });

  it('serves the scripted fake only on a developer machine that asks for it', () => {
    expect(
      getKaanaClient({
        NODE_ENV: 'development',
        ALIA_VOICE_FAKE_UPSTREAM: '1',
      } as NodeJS.ProcessEnv),
    ).toBeInstanceOf(FakeKaana);
    setKaanaClientForTests(undefined);
    expect(
      getKaanaClient({
        NODE_ENV: 'production',
        ALIA_VOICE_FAKE_UPSTREAM: '1',
      } as NodeJS.ProcessEnv),
    ).toBeInstanceOf(Kaana);
  });
});
