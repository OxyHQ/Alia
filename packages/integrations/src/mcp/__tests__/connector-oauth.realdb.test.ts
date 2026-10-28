/**
 * A pre-registered client is used and never stored, and disconnecting a
 * connector deletes its authorization row — after asking the vendor to revoke,
 * and whatever the vendor answered — against a real Postgres.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type IntegrationsDatabase } from '../../db';
import { mcpConnectorAuths } from '../../db/schema';

const TEST_KEY = 'b'.repeat(64);

let db: IntegrationsDatabase;
let AliaOAuthProvider: typeof import('../oauth-provider').AliaOAuthProvider;
let manager: typeof import('../manager');

async function storedRow(oxyUserId: string, serverId: string) {
  const [row] = await db
    .select({
      clientInformation: mcpConnectorAuths.clientInformation,
      tokens: mcpConnectorAuths.tokens,
    })
    .from(mcpConnectorAuths)
    .where(
      and(eq(mcpConnectorAuths.oxyUserId, oxyUserId), eq(mcpConnectorAuths.serverId, serverId)),
    );
  return row ?? null;
}

async function authorize(
  oxyUserId: string,
  serverId: string,
  client?: { clientId: string; clientSecret?: string },
) {
  const provider = new AliaOAuthProvider({
    oxyUserId,
    serverId,
    stateToken: 'state',
    callbackUrl: 'https://api.alia.onl/mcp/oauth/callback',
    client,
  });
  await provider.saveTokens({
    access_token: `access-${serverId}`,
    refresh_token: `refresh-${serverId}`,
    token_type: 'Bearer',
  });
  return provider;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  db = connectPostgres(url);
  ({ AliaOAuthProvider } = await import('../oauth-provider'));
  manager = await import('../manager');
});

afterAll(async () => {
  await closePostgres();
});

describe('a client the vendor issued to Alia', () => {
  it('is the client, and is never written to the row', async () => {
    const provider = await authorize('rev-user-a', 'zoom-1', {
      clientId: 'zoom-client',
      clientSecret: 'zoom-secret',
    });

    expect(await provider.clientInformation()).toEqual({
      client_id: 'zoom-client',
      client_secret: 'zoom-secret',
    });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
    await provider.saveClientInformation({ client_id: 'dynamically-registered' });

    const row = await storedRow('rev-user-a', 'zoom-1');
    expect(row?.clientInformation).toBeNull();
    expect(row?.tokens).not.toContain('zoom-secret');
  });
});

describe('revokeAuthorization', () => {
  it("revokes at the vendor's documented endpoint and deletes only this person's row", async () => {
    await authorize('rev-user-a', 'canva-1');
    await authorize('rev-user-b', 'canva-1');

    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await manager.revokeAuthorization(
      'canva-1',
      'rev-user-a',
      {
        url: 'https://api.canva.com/connect/v1/mcp',
        requiresOAuth: true,
        oauthClient: { clientId: 'canva-client', clientSecret: 'canva-secret' },
        oauthRevocation: { url: 'https://api.canva.com/rest/v1/oauth/revoke', clientAuth: 'basic' },
      },
      fetchFn,
    );

    expect(result).toEqual({ forgotten: true, revocation: { revoked: true } });
    const sent = (fetchFn.mock.calls as unknown as Array<[string, RequestInit]>).map(
      ([url, init]) => [url, (init.body as URLSearchParams).get('token')],
    );
    expect(sent).toEqual([
      ['https://api.canva.com/rest/v1/oauth/revoke', 'refresh-canva-1'],
      ['https://api.canva.com/rest/v1/oauth/revoke', 'access-canva-1'],
    ]);
    expect(await storedRow('rev-user-a', 'canva-1')).toBeNull();
    expect(await storedRow('rev-user-b', 'canva-1')).not.toBeNull();
  });

  it('forgets the tokens even when the vendor cannot be reached', async () => {
    const provider = await authorize('rev-user-a', 'granola-1');
    await provider.saveClientInformation({ client_id: 'granola-dcr-client' });
    const result = await manager.revokeAuthorization(
      'granola-1',
      'rev-user-a',
      { url: 'https://mcp.granola.ai/mcp', requiresOAuth: true },
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(result.forgotten).toBe(true);
    expect(result.revocation).toEqual({ revoked: false, reason: 'unreachable' });
    expect(await storedRow('rev-user-a', 'granola-1')).toBeNull();
  });

  it('answers a connector that was never authorized without creating a row', async () => {
    const result = await manager.revokeAuthorization('never-1', 'rev-user-a', {
      url: 'https://mcp.example.test/mcp',
    });
    expect(result).toEqual({
      forgotten: false,
      revocation: { revoked: false, reason: 'no_tokens' },
    });
    expect(await storedRow('rev-user-a', 'never-1')).toBeNull();
  });
});

describe('startOAuth with a pre-registered client', () => {
  /** Zoom's metadata, as served on 2026-10-28. */
  const ZOOM_PRM = {
    resource: 'https://mcp.zoom.us/mcp/zoom/streamable',
    authorization_servers: ['https://zoom.us'],
    scopes_supported: ['meeting:read:search', 'meeting:delete:meeting'],
    bearer_methods_supported: ['header'],
  };
  const ZOOM_AS = {
    issuer: 'https://zoom.us',
    authorization_endpoint: 'https://zoom.us/oauth/authorize',
    token_endpoint: 'https://zoom.us/oauth/token',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
  };

  it('registers nothing and asks for exactly the configured scopes, with PKCE', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        if (url === 'https://mcp.zoom.us/.well-known/oauth-protected-resource/mcp/zoom/streamable')
          return Response.json(ZOOM_PRM);
        if (url === 'https://zoom.us/.well-known/oauth-authorization-server')
          return Response.json(ZOOM_AS);
        return new Response('not found', { status: 404 });
      }),
    );
    try {
      const { authorizationUrl } = await manager.startOAuth(
        'zoom-2',
        'rev-user-a',
        'streamable-http',
        {
          url: 'https://mcp.zoom.us/mcp/zoom/streamable',
          requiresOAuth: true,
          oauthClient: { clientId: 'zoom-client', clientSecret: 'zoom-secret' },
          oauthScope: 'meeting:read:search',
        },
        'state-123',
        'https://api.alia.onl/mcp/oauth/callback',
      );

      const url = new URL(authorizationUrl);
      expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('zoom-client');
      expect(url.searchParams.get('scope')).toBe('meeting:read:search');
      expect(url.searchParams.get('state')).toBe('state-123');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('redirect_uri')).toBe('https://api.alia.onl/mcp/oauth/callback');
      expect(authorizationUrl).not.toContain('zoom-secret');
      expect(requested.some((u) => u.includes('register'))).toBe(false);

      const row = await storedRow('rev-user-a', 'zoom-2');
      expect(row?.clientInformation).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
