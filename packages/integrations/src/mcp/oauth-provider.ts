/**
 * AliaOAuthProvider — MCP SDK OAuthClientProvider backed by encrypted Mongo.
 *
 * The official `@modelcontextprotocol/sdk` owns the whole OAuth lifecycle
 * (discovery, Dynamic Client Registration, PKCE, token use, auto-refresh) via
 * an `OAuthClientProvider`. This implementation persists the SDK's artifacts —
 * DCR client info, tokens, and the PKCE code verifier — into the
 * `McpConnectorAuth` collection, encrypted at rest via `../shared/crypto`.
 *
 * One instance is bound to a single (user, server) session. The `stateToken`
 * is the opaque OAuth `state` the API mapped to (user, server) so the public
 * callback can be routed back. `redirectToAuthorization` captures the built
 * authorization URL both onto the record and onto the transient
 * `lastAuthorizationUrl` field the start route reads back after `auth()`.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { encrypt, decrypt } from '../shared/crypto';
import { getOrCreateConnectorAuth, type IMcpConnectorAuth } from './oauth-store';

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

  private docPromise: Promise<IMcpConnectorAuth> | null = null;

  constructor(options: AliaOAuthProviderOptions) {
    this.oxyUserId = options.oxyUserId;
    this.serverId = options.serverId;
    this.stateToken = options.stateToken;
    this.callbackUrl = options.callbackUrl;
    this.scope = options.scope;
  }

  private doc(): Promise<IMcpConnectorAuth> {
    if (!this.docPromise) {
      this.docPromise = getOrCreateConnectorAuth(this.oxyUserId, this.serverId);
    }
    return this.docPromise;
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
    const doc = await this.doc();
    if (!doc.clientInformation) return undefined;
    return JSON.parse(decrypt(doc.clientInformation)) as OAuthClientInformationMixed;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const doc = await this.doc();
    doc.clientInformation = encrypt(JSON.stringify(info));
    await doc.save();
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const doc = await this.doc();
    if (!doc.tokens) return undefined;
    return JSON.parse(decrypt(doc.tokens)) as OAuthTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const doc = await this.doc();
    doc.tokens = encrypt(JSON.stringify(tokens));
    await doc.save();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.lastAuthorizationUrl = authorizationUrl.toString();
    const doc = await this.doc();
    doc.authorizationUrl = this.lastAuthorizationUrl;
    await doc.save();
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const doc = await this.doc();
    doc.codeVerifier = encrypt(codeVerifier);
    await doc.save();
  }

  async codeVerifier(): Promise<string> {
    const doc = await this.doc();
    if (!doc.codeVerifier) {
      throw new Error('No PKCE code verifier persisted for this OAuth session');
    }
    return decrypt(doc.codeVerifier);
  }
}
