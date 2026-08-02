import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { OxyServices } from '@oxyhq/core';
import { jwtDecode } from 'jwt-decode';
import { errorMessage } from './errors';

const AUTH_URL = 'https://auth.oxy.so';
const OXY_PLATFORM_URL = 'https://api.oxy.so';
const OXY_CLIENT_ID = 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3';
const CALLBACK_PATH = '/auth-callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
// Refresh a planted access token this long before its JWT `exp` so an in-flight
// request never races the boundary.
const REFRESH_BUFFER_MS = 60 * 1000;
// SecretStorage slot holding the persisted device session (access + rotating
// refresh token). The device-first SDK no longer ships a headless AuthManager,
// so the extension owns its own persistence and refresh loop.
const SESSION_STORAGE_KEY = 'alia.session.v1';

/** The `grant_type` this client uses — RFC 6749 §4.1.3. */
const AUTHORIZATION_CODE_GRANT = 'authorization_code';

/**
 * The user document the token response carries alongside the standard members.
 * Mirrors the wire shape Oxy emits; only the members this extension reads are
 * modelled, because RFC 6749 §5.1 lets the endpoint carry more and a client
 * must ignore whatever it does not recognise.
 */
interface OAuthTokenUser {
  id?: string;
  username?: string;
  /**
   * The canonical composed display name. Present only for accounts that have a
   * real name — username-only accounts carry no `name.displayName` and fall
   * back to the handle.
   */
  name?: { displayName?: string };
}

/**
 * A successful RFC 6749 §5.1 token response.
 *
 * Every member sits at the TOP LEVEL of the document — there is no `data`
 * wrapper. `access_token` and `token_type` are the required standard members;
 * `expires_in` is RECOMMENDED rather than required, so it is optional here and
 * the caller falls back to {@link DEFAULT_TOKEN_LIFETIME_MS}.
 *
 * `session_id` and `user` are Oxy's device-first extras, which §5.1 permits as
 * additional parameters. The response also carries `deviceId` / `deviceSecret`
 * — the zero-cookie restore credentials — which this extension does not
 * consume, so they are deliberately absent from this model.
 *
 * The endpoint issues NO refresh token: §5.1 makes `refresh_token` optional and
 * Oxy's device-first model replaces it with the device secret.
 */
interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  session_id?: string;
  user?: OAuthTokenUser;
}

/** An RFC 6749 §5.2 error document, as the token endpoint emits on failure. */
interface OAuthErrorResponse {
  error: string;
  error_description?: string;
}

interface PersistedSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  userId: string;
  username: string;
}

/** True for a plain JSON object — the shape both OAuth documents take. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string member, or undefined for anything else. */
function stringMember(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a response body as JSON, or null when it is not JSON at all.
 *
 * An intermediary between the extension and the API (corporate proxy, captive
 * portal) can answer with HTML. That must surface as the HTTP status the caller
 * already has, not as a parse error about a body we never expected to read.
 */
async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // Body was absent or not JSON; the status alone describes the failure.
    return null;
  }
}

/**
 * Narrow a parsed body to {@link OAuthTokenUser}, keeping only the members this
 * extension reads.
 */
function parseTokenUser(user: Record<string, unknown>): OAuthTokenUser {
  const name = isRecord(user.name)
    ? { displayName: stringMember(user.name.displayName) }
    : undefined;

  return {
    id: stringMember(user.id),
    username: stringMember(user.username),
    name,
  };
}

/**
 * Narrow a parsed body to a successful RFC 6749 §5.1 token response.
 *
 * Members are read from the TOP LEVEL of the document. Anything the endpoint
 * sends beyond the modelled members is ignored, as §5.1 requires of a client.
 */
function parseTokenResponse(payload: unknown): OAuthTokenResponse {
  if (!isRecord(payload)) {
    throw new Error('OAuth token exchange returned a malformed response.');
  }

  const accessToken = stringMember(payload.access_token);
  if (!accessToken) {
    throw new Error('OAuth token exchange returned no access token.');
  }

  // The token is used unconditionally as a bearer credential, so a grant of any
  // other type is unusable here. RFC 6749 §7.1 makes the value case-insensitive.
  const tokenType = stringMember(payload.token_type);
  if (!tokenType || tokenType.toLowerCase() !== 'bearer') {
    throw new Error(
      `OAuth token exchange returned an unsupported token type (${tokenType ?? 'none'}).`,
    );
  }

  return {
    access_token: accessToken,
    token_type: tokenType,
    expires_in: typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
    session_id: stringMember(payload.session_id),
    user: isRecord(payload.user) ? parseTokenUser(payload.user) : undefined,
  };
}

/**
 * Narrow a parsed body to an RFC 6749 §5.2 error document, or null when the
 * response carries no such document (an HTML error page from a proxy, or a
 * body that simply has no `error` member).
 */
function parseErrorResponse(payload: unknown): OAuthErrorResponse | null {
  if (!isRecord(payload)) { return null; }

  const error = stringMember(payload.error);
  if (!error) { return null; }

  return { error, error_description: stringMember(payload.error_description) };
}

/**
 * Describe a failed token exchange for the sign-in error notification.
 *
 * The §5.2 `error` code is the part a client can act on (`invalid_grant` means
 * "start sign-in again", `invalid_client` means "this build's client_id is
 * wrong"), so it is always shown, with the server's description when there is
 * one. A failure carrying no §5.2 document falls back to the HTTP status.
 */
function describeTokenFailure(status: number, payload: unknown): string {
  const failure = parseErrorResponse(payload);
  if (!failure) {
    return `OAuth token exchange failed (${status}).`;
  }

  return failure.error_description
    ? `${failure.error_description} (${failure.error})`
    : `OAuth token exchange failed: ${failure.error}`;
}

export class AliaAuthenticationProvider
  implements vscode.AuthenticationProvider, vscode.UriHandler, vscode.Disposable
{
  private static readonly AUTH_TYPE = 'alia';
  private static readonly AUTH_NAME = 'Alia';

  private readonly _sessionChangeEmitter =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private readonly _disposable: vscode.Disposable;
  private readonly _oxyServices: OxyServices;
  private readonly _secrets: vscode.SecretStorage;
  private readonly _ready: Promise<void>;

  private _sessions: vscode.AuthenticationSession[] = [];
  private _pendingAuthState: string | null = null;
  private _pendingAuthResolve: ((session: vscode.AuthenticationSession) => void) | null = null;
  private _pendingAuthReject: ((error: Error) => void) | null = null;
  private _pendingAuthTimeout: ReturnType<typeof setTimeout> | null = null;
  private _pendingCodeVerifier: string | null = null;
  private _pendingRedirectUri: string | null = null;
  // Single-flight guard for token rotation. Concurrent callers share one
  // in-flight refresh instead of each rotating the same refresh token — a
  // double rotation trips the server's refresh-token reuse-detection and
  // revokes the whole family.
  private _refreshInFlight: Promise<boolean> | null = null;

  constructor(context: vscode.ExtensionContext) {
    this._oxyServices = new OxyServices({ baseURL: OXY_PLATFORM_URL });
    this._secrets = context.secrets;

    this._ready = this.initialize();

    this._disposable = vscode.Disposable.from(
      vscode.authentication.registerAuthenticationProvider(
        AliaAuthenticationProvider.AUTH_TYPE,
        AliaAuthenticationProvider.AUTH_NAME,
        this,
        { supportsMultipleAccounts: false },
      ),
      vscode.window.registerUriHandler(this),
    );
  }

  get onDidChangeSessions() {
    return this._sessionChangeEmitter.event;
  }

  // --- URI handler ---

  async handleUri(uri: vscode.Uri): Promise<void> {
    // VS Code may fold query params into uri.path (e.g. "/auth-callback?windowId=2"),
    // so we split manually and merge both sources of query parameters.
    const pathOnly = uri.path.split('?')[0];
    const embeddedQuery = uri.path.includes('?')
      ? uri.path.slice(uri.path.indexOf('?') + 1)
      : '';

    if (pathOnly !== CALLBACK_PATH) { return; }

    const params = new URLSearchParams(uri.query);
    for (const [k, v] of new URLSearchParams(embeddedQuery)) {
      if (!params.has(k)) { params.set(k, v); }
    }

    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');

    if (error) {
      this.rejectPending(params.get('error_description') || error);
      return;
    }

    if (this._pendingAuthState && state !== this._pendingAuthState) {
      this.rejectPending('Security validation failed. Please try again.');
      return;
    }

    if (!code) {
      this.rejectPending('No authorization code received.');
      return;
    }

    try {
      if (!this._pendingCodeVerifier || !this._pendingRedirectUri) {
        this.rejectPending('Missing PKCE verifier. Please start sign-in again.');
        return;
      }

      const tokenData = await this.exchangeAuthorizationCode(
        code,
        this._pendingRedirectUri,
        this._pendingCodeVerifier,
      );
      const token = tokenData.access_token;
      this._oxyServices.setTokens(token);

      let userId = tokenData.user?.id || '';
      let username = tokenData.user?.username || tokenData.user?.name?.displayName || '';
      let resolvedSessionId = tokenData.session_id || `browser-${Date.now()}`;
      const expiresAt = new Date(
        Date.now() + (tokenData.expires_in || DEFAULT_TOKEN_LIFETIME_MS / 1000) * 1000,
      ).toISOString();

      try {
        const payload = jwtDecode<{ userId?: string; sub?: string; id?: string; username?: string; sessionId?: string }>(token);
        userId = payload.userId || payload.sub || payload.id || userId;
        username = payload.username || username;
        if (payload.sessionId) { resolvedSessionId = payload.sessionId; }
      } catch { /* token is not a decodable JWT */ }

      const displayName = (await this.resolveDisplayName()) || username || 'Oxy User';
      if (!userId) { userId = `user-${Date.now()}`; }

      // No `refreshToken`: the token endpoint issues no refresh token (RFC 6749
      // §5.1 makes it optional), so a session minted by browser sign-in carries
      // only the access token until it is rotated.
      await this.persistSession({
        accessToken: token,
        expiresAt,
        userId,
        username: displayName,
      });

      const session = this.buildSession(resolvedSessionId, token, userId, displayName);
      const previous = [...this._sessions];
      this._sessions = [session];
      this._sessionChangeEmitter.fire({ added: [session], removed: previous, changed: [] });

      this._pendingAuthResolve?.(session);
      this.clearPendingAuth();

      vscode.window.showInformationMessage(`Signed in as ${displayName}`);
    } catch (err: unknown) {
      this.rejectPending(errorMessage(err));
    }
  }

  // --- Browser sign-in ---

  public async signInWithBrowser(): Promise<vscode.AuthenticationSession> {
    const state = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    this._pendingAuthState = state;
    this._pendingCodeVerifier = codeVerifier;

    const callbackUri = await vscode.env.asExternalUri(
      vscode.Uri.parse(`${vscode.env.uriScheme}://oxy.alia-codea${CALLBACK_PATH}`),
    );
    this._pendingRedirectUri = callbackUri.toString();

    const authUrl = new URL(`${AUTH_URL}/authorize`);
    authUrl.searchParams.set('redirect_uri', callbackUri.toString());
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('client_id', OXY_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('scope', 'openid profile email');

    await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

    return new Promise<vscode.AuthenticationSession>((resolve, reject) => {
      this._pendingAuthResolve = resolve;
      this._pendingAuthReject = reject;
      this._pendingAuthTimeout = setTimeout(() => {
        this.clearPendingAuth();
        reject(new Error('Sign-in timed out. Please try again.'));
      }, SIGN_IN_TIMEOUT_MS);
    });
  }

  // --- Session lifecycle ---

  private async initialize(): Promise<void> {
    const persisted = await this.readPersistedSession();
    if (!persisted) { return; }

    this._oxyServices.setTokens(persisted.accessToken);

    if (!this.isPlantedTokenFresh(persisted.expiresAt)) {
      // Expired on cold start — try to rotate before surfacing a session.
      const refreshed = await this.refreshToken();
      if (!refreshed) {
        await this.clearPersistedSession();
        return;
      }
      return;
    }

    // Restore synchronously from storage — never block cold start on a network
    // round-trip (offline / slow API would otherwise stall extension startup).
    // `username` is the display name resolved at the last sign-in; refresh it
    // lazily in the background and re-emit the session if it has changed.
    this._sessions = [
      this.buildSession(
        `alia-session-${persisted.userId}`,
        persisted.accessToken,
        persisted.userId,
        persisted.username || 'Oxy User',
      ),
    ];
    void this.refreshSessionDisplayName(persisted.userId);
  }

  private async refreshSessionDisplayName(userId: string): Promise<void> {
    const displayName = await this.resolveDisplayName();
    if (!displayName) { return; }

    const existing = this._sessions.find(s => s.account.id === userId);
    if (!existing || existing.account.label === displayName) { return; }

    const updated = this.buildSession(existing.id, existing.accessToken, userId, displayName);
    this._sessions = this._sessions.map(s => (s.id === existing.id ? updated : s));
    this._sessionChangeEmitter.fire({ added: [], removed: [], changed: [updated] });

    // Persist the freshened name so the next cold start restores it directly.
    const persisted = await this.readPersistedSession();
    if (persisted && persisted.userId === userId) {
      await this.persistSession({ ...persisted, username: displayName });
    }
  }

  // --- Public API ---

  public async getAccessToken(): Promise<string | null> {
    await this._ready;

    const persisted = await this.readPersistedSession();
    if (persisted) {
      if (this.isPlantedTokenFresh(persisted.expiresAt)) {
        return this._oxyServices.getAccessToken();
      }
      if (await this.refreshToken()) {
        return this._oxyServices.getAccessToken();
      }
    }

    const apiKey = vscode.workspace.getConfiguration('codea').get<string>('apiKey', '');
    return apiKey?.startsWith('alia_sk_') ? apiKey : null;
  }

  public async refreshToken(): Promise<boolean> {
    // Coalesce concurrent rotations: a stampede of near-expiry callers (e.g. two
    // AI requests firing at once) must share a single rotation. Rotating the
    // same refresh token twice trips server-side reuse-detection and revokes the
    // family. The in-flight promise resolves only after the rotated pair is
    // planted + persisted, so every awaiter observes the new token.
    if (this._refreshInFlight) { return this._refreshInFlight; }

    // `.catch(() => false)` before caching guarantees the shared promise
    // RESOLVES (never rejects): a keychain/storage read failure inside
    // `rotateRefreshToken` (e.g. `readPersistedSession`, which runs before its
    // own try/catch) must surface as a normal `false` to every awaiter — some
    // callers (`initialize`, session restore) `await refreshToken()` without a
    // catch, and a rejected shared promise would become an unhandled rejection
    // and could stall extension init. The `.finally` still clears the cache so a
    // later attempt can retry.
    const inFlight = this.rotateRefreshToken()
      .catch(() => false)
      .finally(() => {
        this._refreshInFlight = null;
      });
    this._refreshInFlight = inFlight;
    return inFlight;
  }

  private async rotateRefreshToken(): Promise<boolean> {
    const persisted = await this.readPersistedSession();
    if (!persisted?.refreshToken) { return false; }

    try {
      const rotated = await this._oxyServices.refreshWithToken(persisted.refreshToken);
      this._oxyServices.setTokens(rotated.accessToken);

      const next: PersistedSession = {
        accessToken: rotated.accessToken,
        // A rotation that omits a new refresh token must NOT wipe the stored
        // one — otherwise a single optional-rotation response would force a full
        // re-sign-in on the next cold start.
        refreshToken: rotated.refreshToken || persisted.refreshToken,
        expiresAt: rotated.expiresAt,
        userId: persisted.userId,
        username: persisted.username,
      };
      await this.persistSession(next);

      const session = this.buildSession(
        `alia-session-${next.userId}`, next.accessToken, next.userId, next.username,
      );
      const wasActive = this._sessions.length > 0;
      this._sessions = [session];
      this._sessionChangeEmitter.fire(
        wasActive
          ? { added: [], removed: [], changed: [session] }
          : { added: [session], removed: [], changed: [] },
      );
      return true;
    } catch {
      return false;
    }
  }

  public getOxyServices(): OxyServices {
    return this._oxyServices;
  }

  // --- VS Code AuthenticationProvider ---

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    await this._ready;
    return this._sessions;
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    return this.signInWithBrowser();
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.clearPersistedSession();
    this._oxyServices.clearTokens();

    const removed = this._sessions.filter(s => s.id === sessionId);
    this._sessions = this._sessions.filter(s => s.id !== sessionId);

    if (removed.length > 0) {
      this._sessionChangeEmitter.fire({ added: [], removed, changed: [] });
    }
  }

  dispose(): void {
    this.clearPendingAuth();
    this._disposable.dispose();
    this._sessionChangeEmitter.dispose();
  }

  // --- Private helpers ---

  private buildSession(
    id: string, token: string, userId: string, label: string,
  ): vscode.AuthenticationSession {
    return { id, accessToken: token, account: { id: userId, label }, scopes: [] };
  }

  private isPlantedTokenFresh(fallbackExpiresAt: string): boolean {
    if (!this._oxyServices.getAccessToken()) { return false; }

    // Prefer the JWT `exp` claim; fall back to the persisted ISO expiry for
    // opaque tokens that carry no decodable expiry.
    const expSeconds = this._oxyServices.getAccessTokenExpiry();
    const expiresAtMs = expSeconds != null
      ? expSeconds * 1000
      : Date.parse(fallbackExpiresAt);
    if (Number.isNaN(expiresAtMs)) { return true; }

    return expiresAtMs > Date.now() + REFRESH_BUFFER_MS;
  }

  private async persistSession(session: PersistedSession): Promise<void> {
    await this._secrets.store(SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  private async readPersistedSession(): Promise<PersistedSession | null> {
    const raw = await this._secrets.get(SESSION_STORAGE_KEY);
    if (!raw) { return null; }
    try {
      // `JSON.parse` yields null/primitives for a corrupt or literal `'null'`
      // slot — reading `.accessToken` off those would throw. Reject anything
      // that is not a populated object.
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) { return null; }
      const session = parsed as PersistedSession;
      if (!session.accessToken || !session.userId) { return null; }
      return session;
    } catch {
      return null;
    }
  }

  private async clearPersistedSession(): Promise<void> {
    await this._secrets.delete(SESSION_STORAGE_KEY);
  }

  private async resolveDisplayName(): Promise<string | null> {
    try {
      const user = await this._oxyServices.getCurrentUser();
      // Prefer the canonical API-composed display name; the SDK returns it on
      // `name.displayName`. Read it without recomputing from first/last.
      const displayName = (user.name as { displayName?: string } | undefined)?.displayName;
      return displayName || user.username || user.email?.split('@')[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Redeem the authorization code for an access token — RFC 6749 §4.1.3.
   *
   * The request is `application/x-www-form-urlencoded` with snake_case
   * parameters and an explicit `grant_type`; the response is read FLAT, as
   * §5.1 defines it. The endpoint previously took camelCase JSON and wrapped
   * its payload in `{ data: … }`, which no OAuth library could read and which
   * left this client guessing whether a wrapper was present.
   *
   * Alia is a PUBLIC client — its `client_id` ships inside a VS Code extension
   * — so it proves itself with the PKCE `code_verifier` and never a client
   * secret.
   *
   * `@oxyhq/core` exposes the same exchange as `OxyServices.exchangeOAuthCode`,
   * which would remove this duplication, and this class already holds an
   * `OxyServices`. It is not used here because that method only speaks RFC 6749
   * from `@oxyhq/core@17`, while this package resolves `^13.0.0` (npm's latest
   * is 16.0.0): calling the SDK today would put the retired camelCase body on
   * the wire. Once core 17 is published and the workspace pin is raised, this
   * method can be replaced by that single call.
   */
  private async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<OAuthTokenResponse> {
    const form = new URLSearchParams({
      grant_type: AUTHORIZATION_CODE_GRANT,
      code,
      redirect_uri: redirectUri,
      client_id: OXY_CLIENT_ID,
      code_verifier: codeVerifier,
    });

    const response = await fetch(`${OXY_PLATFORM_URL}/auth/oauth/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      // Serialised explicitly rather than handed to `fetch` as a
      // `URLSearchParams`, so the body matches the Content-Type set above
      // regardless of which fetch implementation the extension host provides.
      body: form.toString(),
    });

    const payload = await readJsonBody(response);

    if (!response.ok) {
      throw new Error(describeTokenFailure(response.status, payload));
    }

    return parseTokenResponse(payload);
  }

  private rejectPending(message: string): void {
    this._pendingAuthReject?.(new Error(message));
    this.clearPendingAuth();
    vscode.window.showErrorMessage(`Sign-in failed: ${message}`);
  }

  private clearPendingAuth(): void {
    if (this._pendingAuthTimeout) { clearTimeout(this._pendingAuthTimeout); }
    this._pendingAuthState = null;
    this._pendingAuthResolve = null;
    this._pendingAuthReject = null;
    this._pendingAuthTimeout = null;
    this._pendingCodeVerifier = null;
    this._pendingRedirectUri = null;
  }
}
