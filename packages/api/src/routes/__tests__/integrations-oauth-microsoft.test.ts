import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.MICROSOFT_OAUTH_CLIENT_ID = 'ms-client-id';
  process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'ms-client-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client-id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-client-secret';
  process.env.API_BASE_URL = 'https://api.alia.test';
});

vi.mock('../../db/integrations/integrationRepository.js', () => ({
  createIntegration: vi.fn(),
  deleteIntegrationForUser: vi.fn(),
  findIntegrationForUser: vi.fn(),
  listIntegrationsForUser: vi.fn(),
}));

vi.mock('../../db/integrations/oauthStateRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../db/integrations/oauthStateRepository.js')
  >('../../db/integrations/oauthStateRepository.js');
  return {
    OAUTH_STATE_TTL_MS: actual.OAUTH_STATE_TTL_MS,
    createOAuthState: vi.fn(),
    findLiveOAuthState: vi.fn(),
    consumeOAuthState: vi.fn(),
  };
});

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { createIntegration } from '../../db/integrations/integrationRepository.js';
import {
  consumeOAuthState,
  createOAuthState,
  findLiveOAuthState,
} from '../../db/integrations/oauthStateRepository.js';
import router from '../integrations-oauth.js';

const USER = 'user-a';

function handlerOf(method: 'get' | 'post', path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any) => Promise<void> | void;
}

function response() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

/** Microsoft identity platform's token response, as recorded (values replaced). */
const MICROSOFT_TOKEN_RESPONSE = {
  token_type: 'Bearer',
  scope: 'Mail.Read Mail.Send Calendars.ReadWrite User.Read profile openid email',
  expires_in: 4495,
  ext_expires_in: 4495,
  access_token: 'eyJ0eXAi.recorded-access-token',
  refresh_token: '1.AXkA.recorded-refresh-token',
};

/** Graph `GET /me` for a work account, as recorded (values replaced). */
const GRAPH_ME = {
  '@odata.context':
    'https://graph.microsoft.com/v1.0/$metadata#users(id,displayName,mail,userPrincipalName)/$entity',
  id: '87d349ed-44d7-43e1-9a83-5f2406dee5bd',
  displayName: 'Adele Vance',
  mail: 'AdeleV@contoso.example',
  userPrincipalName: 'AdeleV@contoso.example',
};

describe('integrations OAuth for Microsoft 365', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('lists the three Microsoft services as configured, with where to remove consent', async () => {
    const res = response();
    await handlerOf('get', '/available')({ userId: USER }, res);
    const services = res.body.integrations.filter((i: { service: string }) =>
      i.service.startsWith('microsoft-'),
    );
    expect(services.map((i: { service: string }) => i.service)).toEqual([
      'microsoft-outlook',
      'microsoft-teams',
      'microsoft-sharepoint',
    ]);
    for (const service of services) {
      expect(service.configured).toBe(true);
      expect(service.revokeAt).toContain('myapps.microsoft.com');
    }
  });

  it('asks Outlook for its own least scopes, with an S256 PKCE challenge', async () => {
    const res = response();
    await handlerOf('get', '/:service/oauth-url')(
      { userId: USER, params: { service: 'microsoft-outlook' } },
      res,
    );

    const url = new URL(res.body.authUrl);
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(
      ['Calendars.ReadWrite', 'Mail.Read', 'Mail.Send', 'User.Read', 'offline_access'].sort(),
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.alia.test/integrations/microsoft-outlook/callback',
    );
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.has('access_type')).toBe(false);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const stored = vi.mocked(createOAuthState).mock.calls[0]?.[1];
    expect(stored?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(stored!.codeVerifier!).digest('base64url'),
    );
    expect(url.searchParams.get('state')).toBe(stored?.state);
  });

  it('keeps Teams and SharePoint on work accounts and away from admin-only scopes', async () => {
    for (const service of ['microsoft-teams', 'microsoft-sharepoint']) {
      const res = response();
      await handlerOf('get', '/:service/oauth-url')({ userId: USER, params: { service } }, res);
      const url = new URL(res.body.authUrl);
      expect(url.pathname).toBe('/organizations/oauth2/v2.0/authorize');
      const scopes = url.searchParams.get('scope') ?? '';
      expect(scopes).not.toMatch(/ChannelMessage\.Read\.All|ReadWrite\.All|Directory/);
    }
  });

  it('keeps Google on offline access, now with PKCE too', async () => {
    const res = response();
    await handlerOf('get', '/:service/oauth-url')(
      { userId: USER, params: { service: 'google-calendar' } },
      res,
    );
    const url = new URL(res.body.authUrl);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('redeems the code with the stored verifier and records the Microsoft account', async () => {
    vi.mocked(findLiveOAuthState).mockResolvedValue({
      id: 'state-token',
      service: 'microsoft-outlook',
      userId: USER,
      expiresAt: new Date(Date.now() + 60_000),
      codeVerifier: 'the-verifier',
    });
    vi.mocked(consumeOAuthState).mockResolvedValue(true);
    vi.mocked(createIntegration).mockResolvedValue({ id: 'int-1' } as any);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => MICROSOFT_TOKEN_RESPONSE })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => GRAPH_ME });

    const res = response();
    await handlerOf('post', '/:service/complete')(
      {
        userId: USER,
        params: { service: 'microsoft-outlook' },
        body: { state: 'state-token', code: 'the-code' },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    );
    const form = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(form.get('code_verifier')).toBe('the-verifier');
    expect(form.get('client_id')).toBe('ms-client-id');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('https://graph.microsoft.com/v1.0/me');

    expect(createIntegration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        oxyUserId: USER,
        service: 'microsoft-outlook',
        accessToken: MICROSOFT_TOKEN_RESPONSE.access_token,
        refreshToken: MICROSOFT_TOKEN_RESPONSE.refresh_token,
        accountId: GRAPH_ME.id,
        accountName: GRAPH_ME.mail,
      }),
    );
  });
});
