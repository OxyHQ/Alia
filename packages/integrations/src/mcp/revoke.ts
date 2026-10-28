/**
 * Token revocation for remote MCP connectors (RFC 7009).
 *
 * Disconnecting a connector asks the vendor to forget the grant, not only Alia:
 * the authorization server is found the same way the SDK found it to connect
 * (RFC 9728 protected-resource metadata, then RFC 8414 / OIDC discovery), and
 * its `revocation_endpoint`, when it advertises one, receives the refresh token
 * and then the access token. A vendor with no such endpoint (or one that is
 * down) is reported, and the caller deletes the stored tokens either way.
 *
 * Nothing here logs or returns a token; the outcome is a reason code.
 */

import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

export type RevocationOutcome =
  | { revoked: true }
  | {
      revoked: false;
      reason: 'no_tokens' | 'no_client' | 'no_revocation_endpoint' | 'refused' | 'unreachable';
    };

const REVOCATION_TIMEOUT_MS = 10_000;

export async function revokeConnectorTokens(input: {
  serverUrl: string;
  tokens: OAuthTokens | undefined;
  client: OAuthClientInformationMixed | undefined;
  documented?: { url: string; clientAuth: 'basic' | 'body' };
  fetchFn?: FetchLike;
}): Promise<RevocationOutcome> {
  const { serverUrl, tokens, client } = input;
  const fetchFn: FetchLike = input.fetchFn ?? ((url, init) => fetch(url, init));
  if (!tokens?.access_token && !tokens?.refresh_token)
    return { revoked: false, reason: 'no_tokens' };
  if (!client?.client_id) return { revoked: false, reason: 'no_client' };

  let endpoint: string | undefined;
  let authMethods: string[] | undefined;
  if (input.documented) {
    endpoint = input.documented.url;
    authMethods = [
      input.documented.clientAuth === 'basic' ? 'client_secret_basic' : 'client_secret_post',
    ];
  } else {
    try {
      const info = await discoverOAuthServerInfo(serverUrl, { fetchFn });
      if (!info.authorizationServerMetadata) return { revoked: false, reason: 'unreachable' };
      const metadata: Record<string, unknown> = { ...info.authorizationServerMetadata };
      if (typeof metadata.revocation_endpoint === 'string') endpoint = metadata.revocation_endpoint;
      const methods = metadata.revocation_endpoint_auth_methods_supported;
      if (Array.isArray(methods)) authMethods = methods.filter((m) => typeof m === 'string');
    } catch {
      return { revoked: false, reason: 'unreachable' };
    }
  }
  if (!endpoint) return { revoked: false, reason: 'no_revocation_endpoint' };

  const attempts: Array<[string, 'refresh_token' | 'access_token']> = [];
  if (tokens.refresh_token) attempts.push([tokens.refresh_token, 'refresh_token']);
  if (tokens.access_token) attempts.push([tokens.access_token, 'access_token']);

  const secret = 'client_secret' in client ? client.client_secret : undefined;
  const useBasic = !!secret && (authMethods?.includes('client_secret_basic') ?? false);

  let refused = false;
  for (const [token, hint] of attempts) {
    const body = new URLSearchParams({ token, token_type_hint: hint });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (useBasic && secret) {
      const pair = `${encodeURIComponent(client.client_id)}:${encodeURIComponent(secret)}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
    } else {
      body.set('client_id', client.client_id);
      if (secret) body.set('client_secret', secret);
    }
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
      });
      if (!response.ok) refused = true;
    } catch {
      return { revoked: false, reason: 'unreachable' };
    }
  }
  return refused ? { revoked: false, reason: 'refused' } : { revoked: true };
}
