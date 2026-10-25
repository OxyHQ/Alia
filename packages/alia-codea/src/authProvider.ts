import * as vscode from 'vscode';
import { generateOAuthState, generatePkcePair, OxyServices } from '@oxy.so/core';
import {
  createNativeAuthStateStore,
  installAuthRefreshHandler,
  runSessionColdBoot,
  startTokenRefreshScheduler,
  type AuthStateStore,
} from '@oxy.so/core/session';
import { errorMessage } from './errors';

const AUTH_URL = 'https://auth.oxy.so';
const OXY_PLATFORM_URL = 'https://api.oxy.so';
const OXY_CLIENT_ID = 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3';
const CALLBACK_PATH = '/auth-callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
// VS Code display/session metadata. Core's AuthStateStore owns the device
// credential, and its handler/scheduler own refresh; no refresh token exists.
const SESSION_STORAGE_KEY = 'alia.session.v1';

/**
 * The extension's own display state, NOT the credential.
 *
 * `refreshToken` is deliberately gone. Under the device-first model there is no
 * app-held refresh token to rotate: `{ deviceId, deviceSecret }` mints a short
 * access token via `POST /session/device/token`, and `@oxy.so/core`'s
 * `AuthStateStore` owns that credential. What stays here is what VS Code's
 * session list needs and core does not model — the display name.
 */
interface PersistedSession {
  userId: string;
  username: string;
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
  private readonly _authStore: AuthStateStore;
  private _disposeRefresh: (() => void) | null = null;
  private _scheduler: { dispose(): void } | null = null;
  private readonly _ready: Promise<void>;

  private _sessions: vscode.AuthenticationSession[] = [];
  private _disposed = false;
  private _pendingAuthState: string | null = null;
  private _pendingAuthResolve: ((session: vscode.AuthenticationSession) => void) | null = null;
  private _pendingAuthReject: ((error: Error) => void) | null = null;
  private _pendingAuthTimeout: ReturnType<typeof setTimeout> | null = null;
  private _pendingCodeVerifier: string | null = null;
  private _pendingRedirectUri: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this._oxyServices = new OxyServices({ baseURL: OXY_PLATFORM_URL });
    this._secrets = context.secrets;

    /**
     * The device credential, in VS Code's own secret storage.
     *
     * `createNativeAuthStateStore` takes any async key/value backing — its own
     * doc says the factory is injected "so `@oxy.so/core` never imports
     * `expo-secure-store`" — and `vscode.SecretStorage` is exactly that shape,
     * backed by the OS keychain. So the extension supplies the one
     * platform-specific piece and inherits the cold boot, the re-mint lane and
     * the rotation scheduler unchanged.
     */
    // `vscode.SecretStorage` returns `Thenable`, not `Promise`; core's contract
    // asks for `Promise`. `Promise.resolve` adapts it rather than widening the
    // contract, which keeps `.catch`/`.finally` available to core's internals.
    this._authStore = createNativeAuthStateStore({
      getItem: async (key) => (await this._secrets.get(key)) ?? null,
      setItem: async (key, value) => {
        await this._secrets.store(key, value);
      },
      removeItem: async (key) => {
        await this._secrets.delete(key);
      },
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
    const embeddedQuery = uri.path.includes('?') ? uri.path.slice(uri.path.indexOf('?') + 1) : '';

    if (pathOnly !== CALLBACK_PATH) {
      return;
    }

    const params = new URLSearchParams(uri.query);
    for (const [k, v] of new URLSearchParams(embeddedQuery)) {
      if (!params.has(k)) {
        params.set(k, v);
      }
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

      /**
       * Core's own exchange, not a hand-rolled `fetch`.
       *
       * The difference that matters is the RESPONSE: `exchangeOAuthCode`
       * returns a `LoginSessionResult` carrying `deviceId` and `deviceSecret`,
       * which is the credential the whole device-first restore is built on. The
       * raw form POST this replaced returned only an access token, so every
       * cold start after it had nothing to re-mint from and fell back to
       * rotating a refresh token that the endpoint does not issue.
       */
      const result = await this._oxyServices.auth.oauth.exchangeCode({
        code,
        clientId: OXY_CLIENT_ID,
        redirectUri: this._pendingRedirectUri,
        codeVerifier: this._pendingCodeVerifier,
      });
      const token = result.accessToken;
      if (!token) {
        this.rejectPending('Oxy returned no access token for this sign-in.');
        return;
      }
      this._oxyServices.session.setAccessToken(token);

      const userId = result.user.id;
      const resolvedSessionId = result.sessionId;
      const expiresAt = result.expiresAt;
      const displayName = (await this.resolveDisplayName()) || result.user.username || 'Oxy User';

      /**
       * Two stores, and they hold different things on purpose.
       *
       * `_authStore` holds the CREDENTIAL — `{ deviceId, deviceSecret }` plus
       * the warm token — and is the only thing a cold boot re-mints from. It is
       * written FIRST and its durability is checked, because advertising a
       * session built on a secret that did not land is what signs people out on
       * restart.
       *
       * `persistSession` holds the DISPLAY state VS Code's session list needs
       * and core does not model.
       */
      const durable = await this._authStore.save({
        sessionId: result.sessionId,
        userId,
        deviceId: result.deviceId,
        deviceSecret: result.deviceSecret,
        accessToken: token,
        expiresAt,
      });
      if (!durable) {
        this.rejectPending('Could not save the session to the OS keychain.');
        return;
      }
      this.installRefresh();

      await this.persistSession({
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
    const [state, { codeVerifier, codeChallenge }] = await Promise.all([
      generateOAuthState(),
      generatePkcePair(),
    ]);
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

  /**
   * Install core's re-mint handler and its proactive scheduler.
   *
   * Idempotent: a second call disposes the first, so signing in after a restore
   * never leaves two schedulers racing on one token.
   */
  private installRefresh(): void {
    this._disposeRefresh?.();
    this._scheduler?.dispose();
    this._disposeRefresh = installAuthRefreshHandler({
      oxy: this._oxyServices,
      store: this._authStore,
    });
    this._scheduler = startTokenRefreshScheduler(this._oxyServices);
  }

  private async initialize(): Promise<void> {
    this.installRefresh();
    const outcome = await runSessionColdBoot({
      oxy: this._oxyServices,
      store: this._authStore,
      platform: { isWeb: false, isNative: false },
      overallDeadlineMs: 15_000,
    });
    if (this._disposed || outcome.kind !== 'session') return;
    const { sessionId, userId, accessToken } = outcome.session;
    const display = await this.readPersistedSession();
    if (this._disposed) return;
    this._sessions = [
      this.buildSession(
        sessionId,
        accessToken,
        userId,
        display?.userId === userId ? display.username : 'Oxy User',
      ),
    ];
    void this.refreshSessionDisplayName(userId);
  }

  private async refreshSessionDisplayName(userId: string): Promise<void> {
    const displayName = await this.resolveDisplayName();
    if (!displayName) {
      return;
    }

    const existing = this._sessions.find((s) => s.account.id === userId);
    if (!existing || existing.account.label === displayName) {
      return;
    }

    const updated = this.buildSession(existing.id, existing.accessToken, userId, displayName);
    this._sessions = this._sessions.map((s) => (s.id === existing.id ? updated : s));
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
    if (this._disposed) return null;
    const client = this.createLinkedClient(OXY_PLATFORM_URL);
    try {
      return await client.getAccessToken(OXY_PLATFORM_URL);
    } finally {
      client.dispose();
    }
  }

  public createLinkedClient(baseURL: string) {
    return this._oxyServices.createLinkedClient({ baseURL });
  }

  /** Same-account refresh stays live; account/sign-out changes cancel old work. */
  public onSessionContextChange(listener: () => void): () => void {
    let epoch = this._oxyServices.http.getSessionEpoch();
    return this._oxyServices.http.addTokenChangeListener(() => {
      const next = this._oxyServices.http.getSessionEpoch();
      if (next === epoch) return;
      epoch = next;
      listener();
    });
  }

  /** Explicit refresh command; request-time refresh belongs to the linked transport. */
  public async refreshToken(): Promise<boolean> {
    return (await this._oxyServices.http.refreshAccessToken('preflight')) !== null;
  }

  public getOxyServices(): OxyServices {
    return this._oxyServices;
  }

  // --- VS Code AuthenticationProvider ---

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    await this._ready;
    const token = this._oxyServices.session.accessToken;
    return token ? this._sessions.map((session) => ({ ...session, accessToken: token })) : [];
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    return this.signInWithBrowser();
  }

  async removeSession(sessionId: string): Promise<void> {
    this._disposeRefresh?.();
    this._disposeRefresh = null;
    this._scheduler?.dispose();
    this._scheduler = null;
    this._oxyServices.session.clear();
    await Promise.all([this.clearPersistedSession(), this._authStore.clear()]);

    const removed = this._sessions.filter((s) => s.id === sessionId);
    this._sessions = this._sessions.filter((s) => s.id !== sessionId);

    if (removed.length > 0) {
      this._sessionChangeEmitter.fire({ added: [], removed, changed: [] });
    }
  }

  dispose(): void {
    this._disposed = true;
    this.clearPendingAuth();
    this._disposable.dispose();
    this._sessionChangeEmitter.dispose();
    this._disposeRefresh?.();
    this._scheduler?.dispose();
    this._oxyServices.dispose();
  }

  // --- Private helpers ---

  private buildSession(
    id: string,
    token: string,
    userId: string,
    label: string,
  ): vscode.AuthenticationSession {
    return { id, accessToken: token, account: { id: userId, label }, scopes: [] };
  }

  private async persistSession(session: PersistedSession): Promise<void> {
    await this._secrets.store(SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  private async readPersistedSession(): Promise<PersistedSession | null> {
    const raw = await this._secrets.get(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    try {
      // `JSON.parse` yields null/primitives for a corrupt or literal `'null'`
      // slot — reading fields off those would throw. Reject anything
      // that is not a populated object.
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      const session = parsed as PersistedSession;
      if (
        typeof session.userId !== 'string' ||
        !session.userId ||
        typeof session.username !== 'string'
      ) {
        return null;
      }
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
      const user = await this._oxyServices.users.me();
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
   * `@oxy.so/core` exposes the same exchange as `OxyServices.exchangeOAuthCode`,
   * which would remove this duplication, and this class already holds an
   * `OxyServices`. It is not used here because that method only speaks RFC 6749
   * from `@oxy.so/core@17`, while this package resolves `^13.0.0` (npm's latest
   * is 16.0.0): calling the SDK today would put the retired camelCase body on
   * the wire. Once core 17 is published and the workspace pin is raised, this
   * method can be replaced by that single call.
   */
  private rejectPending(message: string): void {
    this._pendingAuthReject?.(new Error(message));
    this.clearPendingAuth();
    vscode.window.showErrorMessage(`Sign-in failed: ${message}`);
  }

  private clearPendingAuth(): void {
    if (this._pendingAuthTimeout) {
      clearTimeout(this._pendingAuthTimeout);
    }
    this._pendingAuthState = null;
    this._pendingAuthResolve = null;
    this._pendingAuthReject = null;
    this._pendingAuthTimeout = null;
    this._pendingCodeVerifier = null;
    this._pendingRedirectUri = null;
  }
}
