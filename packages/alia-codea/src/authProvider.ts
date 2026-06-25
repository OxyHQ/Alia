import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { OxyServices, createAuthManager } from '@oxyhq/core';
import type { AuthManager, StorageAdapter, SessionLoginResponse, MinimalUserData } from '@oxyhq/core';
import { jwtDecode } from 'jwt-decode';

const AUTH_URL = 'https://auth.oxy.so';
const OXY_PLATFORM_URL = 'https://api.oxy.so';
const OXY_CLIENT_ID = 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3';
const CALLBACK_PATH = '/auth-callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

type OAuthTokenExchange = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  session_id: string;
  user?: {
    id?: string;
    username?: string | null;
    displayName?: string | null;
    email?: string | null;
  };
};

class VsCodeStorageAdapter implements StorageAdapter {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getItem(key: string): Promise<string | null> {
    return (await this.secrets.get(key)) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  async removeItem(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
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
  private readonly _authManager: AuthManager;
  private readonly _ready: Promise<void>;

  private _sessions: vscode.AuthenticationSession[] = [];
  private _pendingAuthState: string | null = null;
  private _pendingAuthResolve: ((session: vscode.AuthenticationSession) => void) | null = null;
  private _pendingAuthReject: ((error: Error) => void) | null = null;
  private _pendingAuthTimeout: ReturnType<typeof setTimeout> | null = null;
  private _pendingCodeVerifier: string | null = null;
  private _pendingRedirectUri: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this._oxyServices = new OxyServices({ baseURL: OXY_PLATFORM_URL });
    this._authManager = createAuthManager(this._oxyServices, {
      storage: new VsCodeStorageAdapter(context.secrets),
      autoRefresh: true,
      refreshBuffer: 5 * 60 * 1000,
    });

    this._authManager.onAuthStateChange((user: MinimalUserData | null) => {
      this.handleAuthStateChange(user);
    });

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
      let username = tokenData.user?.username || tokenData.user?.displayName || '';
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

      const sessionResponse: SessionLoginResponse = {
        accessToken: token,
        sessionId: resolvedSessionId,
        deviceId: 'vscode-codea',
        expiresAt,
        user: { id: userId, username: displayName },
      };

      await this._authManager.handleAuthSuccess(sessionResponse, 'redirect');

      const session = this.buildSession(resolvedSessionId, token, userId, displayName);
      this._sessions = [session];
      this._sessionChangeEmitter.fire({ added: [session], removed: [], changed: [] });

      this._pendingAuthResolve?.(session);
      this.clearPendingAuth();

      vscode.window.showInformationMessage(`Signed in as ${displayName}`);
    } catch (err: any) {
      this.rejectPending(err.message);
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
    try {
      const user = await this._authManager.initialize();
      if (!user) { return; }

      const token = await this._authManager.getAccessToken();
      if (token) { this._oxyServices.setTokens(token); }

      const displayName = (await this.resolveDisplayName()) || user.username || 'Oxy User';
      this._sessions = [this.buildSession(`alia-session-${user.id}`, token || '', user.id, displayName)];
    } catch {
      // No persisted session to restore
    }
  }

  private async handleAuthStateChange(user: MinimalUserData | null): Promise<void> {
    if (user) {
      const token = await this._authManager.getAccessToken();
      const displayName = (await this.resolveDisplayName()) || user.username || 'Oxy User';
      const session = this.buildSession(`alia-session-${user.id}`, token || '', user.id, displayName);

      const previous = [...this._sessions];
      this._sessions = [session];

      const isUpdate = previous.length > 0 && previous[0].id === session.id;
      this._sessionChangeEmitter.fire(
        isUpdate
          ? { added: [], removed: [], changed: [session] }
          : { added: [session], removed: previous, changed: [] },
      );
    } else {
      if (this._pendingAuthResolve) { return; }

      const removed = [...this._sessions];
      this._sessions = [];
      if (removed.length > 0) {
        this._sessionChangeEmitter.fire({ added: [], removed, changed: [] });
      }
    }
  }

  // --- Public API ---

  public async getAccessToken(): Promise<string | null> {
    await this._ready;

    const jwt = await this._authManager.getAccessToken();
    if (jwt) { return jwt; }

    const apiKey = vscode.workspace.getConfiguration('codea').get<string>('apiKey', '');
    return apiKey?.startsWith('alia_sk_') ? apiKey : null;
  }

  public async refreshToken(): Promise<boolean> {
    try { return await this._authManager.refreshToken(); }
    catch { return false; }
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
    await this._authManager.signOut();
    this._oxyServices.clearTokens();

    const removed = this._sessions.filter(s => s.id === sessionId);
    this._sessions = this._sessions.filter(s => s.id !== sessionId);

    if (removed.length > 0) {
      this._sessionChangeEmitter.fire({ added: [], removed, changed: [] });
    }
  }

  dispose(): void {
    this.clearPendingAuth();
    this._authManager.destroy();
    this._disposable.dispose();
    this._sessionChangeEmitter.dispose();
  }

  // --- Private helpers ---

  private buildSession(
    id: string, token: string, userId: string, label: string,
  ): vscode.AuthenticationSession {
    return { id, accessToken: token, account: { id: userId, label }, scopes: [] };
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

  private async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<OAuthTokenExchange> {
    const response = await fetch(`${OXY_PLATFORM_URL}/auth/oauth/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        clientId: OXY_CLIENT_ID,
        redirectUri,
        codeVerifier,
      }),
    });

    if (!response.ok) {
      throw new Error(`OAuth token exchange failed (${response.status})`);
    }

    const payload = await response.json() as { data?: OAuthTokenExchange } & Partial<OAuthTokenExchange>;
    const data = payload.data ?? payload;
    if (!data.access_token) {
      throw new Error('OAuth token exchange returned no access token.');
    }
    return data as OAuthTokenExchange;
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
