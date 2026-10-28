/**
 * RFC 7009 revocation against fake authorization servers whose metadata is the
 * vendors' own, as recorded on 2026-10-28 (trimmed to the fields discovery reads).
 */

import { describe, expect, it, vi } from 'vitest';
import { revokeConnectorTokens } from '../revoke';

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeVendor(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    return route ? route(init) : new Response('not found', { status: 404 });
  });
  return { fetchFn, calls };
}

const ATLASSIAN_AS = 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3';

/** Atlassian Rovo MCP v2: protected-resource metadata and its authorization server's. */
const atlassian = () =>
  fakeVendor({
    'https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp': () =>
      json({
        resource: 'https://mcp.atlassian.com/v2/mcp',
        authorization_servers: [ATLASSIAN_AS],
        scopes_supported: ['offline_access', 'read:jira:agent-interface'],
      }),
    'https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3':
      () =>
        json({
          issuer: ATLASSIAN_AS,
          authorization_endpoint: `${ATLASSIAN_AS}/authorize`,
          token_endpoint: `${ATLASSIAN_AS}/oauth/token`,
          registration_endpoint: `${ATLASSIAN_AS}/dcr/register`,
          revocation_endpoint: 'https://auth.atlassian.com/oauth/revoke',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        }),
    'https://auth.atlassian.com/oauth/revoke': () => new Response(null, { status: 200 }),
  });

/** Granola: an authorization server with no revocation endpoint. */
const granola = () =>
  fakeVendor({
    'https://mcp.granola.ai/.well-known/oauth-protected-resource/mcp': () =>
      json({
        resource: 'https://mcp.granola.ai/mcp',
        authorization_servers: ['https://mcp-auth.granola.ai'],
        scopes_supported: ['mcp'],
      }),
    'https://mcp-auth.granola.ai/.well-known/oauth-authorization-server': () =>
      json({
        issuer: 'https://mcp-auth.granola.ai',
        authorization_endpoint: 'https://mcp-auth.granola.ai/oauth2/authorize',
        token_endpoint: 'https://mcp-auth.granola.ai/oauth2/token',
        registration_endpoint: 'https://mcp-auth.granola.ai/oauth2/register',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      }),
  });

const tokens = { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer' };

describe('revokeConnectorTokens', () => {
  it("revokes the refresh token, then the access token, at the vendor's advertised endpoint", async () => {
    const vendor = atlassian();
    const outcome = await revokeConnectorTokens({
      serverUrl: 'https://mcp.atlassian.com/v2/mcp',
      tokens,
      client: { client_id: 'dcr-client' },
      fetchFn: vendor.fetchFn,
    });

    expect(outcome).toEqual({ revoked: true });
    const revocations = vendor.calls.filter(
      (c) => c.url === 'https://auth.atlassian.com/oauth/revoke',
    );
    expect(revocations.map((c) => Object.fromEntries(c.init?.body as URLSearchParams))).toEqual([
      { token: 'refresh-1', token_type_hint: 'refresh_token', client_id: 'dcr-client' },
      { token: 'access-1', token_type_hint: 'access_token', client_id: 'dcr-client' },
    ]);
  });

  it('reports a vendor that has no revocation endpoint, so the caller only forgets', async () => {
    const vendor = granola();
    const outcome = await revokeConnectorTokens({
      serverUrl: 'https://mcp.granola.ai/mcp',
      tokens,
      client: { client_id: 'dcr-client' },
      fetchFn: vendor.fetchFn,
    });
    expect(outcome).toEqual({ revoked: false, reason: 'no_revocation_endpoint' });
  });

  it("uses a vendor's documented endpoint with HTTP Basic client authentication", async () => {
    const vendor = fakeVendor({
      'https://zoom.us/oauth/revoke': () => json({ status: 'success' }),
    });
    const outcome = await revokeConnectorTokens({
      serverUrl: 'https://mcp.zoom.us/mcp/zoom/streamable',
      tokens: { access_token: 'access-1', token_type: 'Bearer' },
      client: { client_id: 'zoom-client', client_secret: 'zoom-secret' },
      documented: { url: 'https://zoom.us/oauth/revoke', clientAuth: 'basic' },
      fetchFn: vendor.fetchFn,
    });

    expect(outcome).toEqual({ revoked: true });
    expect(vendor.calls).toHaveLength(1);
    const { init } = vendor.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('zoom-client:zoom-secret').toString('base64')}`,
    );
    const form = init?.body as URLSearchParams;
    expect(form.get('token')).toBe('access-1');
    expect(form.has('client_secret')).toBe(false);
  });

  it('says the vendor refused when its endpoint answers an error', async () => {
    const vendor = fakeVendor({
      'https://api.canva.com/rest/v1/oauth/revoke': () => json({ error: 'invalid_client' }, 401),
    });
    const outcome = await revokeConnectorTokens({
      serverUrl: 'https://api.canva.com/connect/v1/mcp',
      tokens,
      client: { client_id: 'canva-client', client_secret: 'canva-secret' },
      documented: { url: 'https://api.canva.com/rest/v1/oauth/revoke', clientAuth: 'basic' },
      fetchFn: vendor.fetchFn,
    });
    expect(outcome).toEqual({ revoked: false, reason: 'refused' });
  });

  it('does nothing without tokens', async () => {
    const vendor = atlassian();
    const outcome = await revokeConnectorTokens({
      serverUrl: 'https://mcp.atlassian.com/v2/mcp',
      tokens: undefined,
      client: { client_id: 'dcr-client' },
      fetchFn: vendor.fetchFn,
    });
    expect(outcome).toEqual({ revoked: false, reason: 'no_tokens' });
    expect(vendor.fetchFn).not.toHaveBeenCalled();
  });

  it('reports an unreachable vendor rather than throwing', async () => {
    const outcome = await revokeConnectorTokens({
      serverUrl: 'https://mcp.atlassian.com/v2/mcp',
      tokens,
      client: { client_id: 'dcr-client' },
      fetchFn: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    expect(outcome).toEqual({ revoked: false, reason: 'unreachable' });
  });
});
