/**
 * AliaOAuthProvider — MCP SDK OAuthClientProvider backed by encrypted Postgres.
 *
 * The official `@modelcontextprotocol/sdk` owns the whole OAuth lifecycle
 * (discovery, Dynamic Client Registration, PKCE, token use, auto-refresh) via
 * an `OAuthClientProvider`. This implementation persists the SDK's artifacts —
 * DCR client info, tokens, and the PKCE code verifier — into
 * `mcp_connector_auths`, encrypted at rest via `../shared/crypto`.
 *
 * **Encryption happens HERE, not in the column.** `encrypt()` on the way in and
 * `decrypt()` on the way out, with the store holding opaque `text`. That is the
 * arrangement the Mongoose version had and the port keeps it byte-for-byte;
 * `oauth-store.ts` states what both ways of changing it would break.
 *
 * One instance is bound to a single (user, server) session. The `stateToken` is
 * the opaque OAuth `state` the API mapped to (user, server) so the public
 * callback can be routed back. `redirectToAuthorization` captures the built
 * authorization URL both onto the record and onto the transient
 * `lastAuthorizationUrl` field the start route reads back after `auth()`.
 *
 * ## Why the row is loaded once and then tracked in memory
 *
 * The Mongoose version held one hydrated document for the provider's lifetime,
 * mutated it and called `save()`; a read after a write therefore saw the write.
 * Reads here are served from the same in-memory copy for exactly that reason —
 * the SDK writes a code verifier and reads it back within one `auth()` call,
 * and a re-read from the database would be a second round trip that answers the
 * same question. Each HTTP request builds a fresh provider, so nothing is
 * cached across requests.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { getDb } from '../db';
import { encrypt, decrypt } from '../shared/crypto';
import {
  getOrCreateConnectorAuth,
  updateConnectorAuth,
  type ConnectorAuthUpdate,
  type McpConnectorAuthRow,
} from './oauth-store';

export interface AliaOAuthProviderOptions {
  oxyUserId: string;
  serverId: string;
  /** Opaque OAuth `state` mapping the callback back to (user, server). */
  stateToken: string;
  /** Fixed public API callback URL the AS redirects to. */
  callbackUrl: string;
  /** Optional OAuth scope to request. */
  scope?: string;
}

export class AliaOAuthProvider implements OAuthClientProvider {
  private readonly oxyUserId: string;
  private readonly serverId: string;
  private readonly stateToken: string;
  private readonly callbackUrl: string;
  private readonly scope?: string;

  /**
   * Transient authorization URL produced by the SDK during `auth()`; read back
   * by the start route once `auth()` returns `'REDIRECT'`.
   */
  lastAuthorizationUrl?: string;

  private rowPromise: Promise<McpConnectorAuthRow> | null = null;

  constructor(options: AliaOAuthProviderOptions) {
    this.oxyUserId = options.oxyUserId;
    this.serverId = options.serverId;
    this.stateToken = options.stateToken;
    this.callbackUrl = options.callbackUrl;
    this.scope = options.scope;
  }

  private row(): Promise<McpConnectorAuthRow> {
    if (!this.rowPromise) {
      this.rowPromise = getOrCreateConnectorAuth(getDb(), this.oxyUserId, this.serverId);
    }
    return this.rowPromise;
  }

  /** Persist one field and keep the in-memory copy in step with it. */
  private async write(update: ConnectorAuthUpdate): Promise<void> {
    const row = await this.row();
    await updateConnectorAuth(getDb(), row.id, update);
    this.rowPromise = Promise.resolve({ ...row, ...update });
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Alia',
      redirect_uris: [this.callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  state(): string {
    return this.stateToken;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = await this.row();
    if (!row.clientInformation) return undefined;
    return JSON.parse(decrypt(row.clientInformation)) as OAuthClientInformationMixed;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.write({ clientInformation: encrypt(JSON.stringify(info)) });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const row = await this.row();
    if (!row.tokens) return undefined;
    return JSON.parse(decrypt(row.tokens)) as OAuthTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write({ tokens: encrypt(JSON.stringify(tokens)) });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.lastAuthorizationUrl = authorizationUrl.toString();
    await this.write({ authorizationUrl: this.lastAuthorizationUrl });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.write({ codeVerifier: encrypt(codeVerifier) });
  }

  async codeVerifier(): Promise<string> {
    const row = await this.row();
    if (!row.codeVerifier) {
      throw new Error('No PKCE code verifier persisted for this OAuth session');
    }
    return decrypt(row.codeVerifier);
  }
}
