import * as vscode from 'vscode';

/**
 * Alia Authentication Provider
 *
 * This provider bridges the gap between the simple API key approach
 * and Codea Studio Code's OAuth-based authentication system.
 *
 * It registers with the ID "alia" (matching product.json's provider.default.id)
 * and creates sessions from the stored API key.
 */
export class AliaAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private static readonly AUTH_TYPE = 'alia';
  private static readonly AUTH_NAME = 'Alia';
  private static readonly SESSIONS_KEY = 'alia.sessions';

  private _sessionChangeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private _disposable: vscode.Disposable;
  private _sessions: vscode.AuthenticationSession[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this._disposable = vscode.Disposable.from(
      vscode.authentication.registerAuthenticationProvider(
        AliaAuthenticationProvider.AUTH_TYPE,
        AliaAuthenticationProvider.AUTH_NAME,
        this,
        { supportsMultipleAccounts: false }
      )
    );

    // Load existing sessions
    this.loadSessions();

    // Watch for API key changes
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('codea.apiKey')) {
        await this.syncSessionWithApiKey();
      }
    });

    // Initial sync
    this.syncSessionWithApiKey();
  }

  get onDidChangeSessions() {
    return this._sessionChangeEmitter.event;
  }

  private async loadSessions(): Promise<void> {
    const sessionsData = await this.context.secrets.get(AliaAuthenticationProvider.SESSIONS_KEY);
    if (sessionsData) {
      try {
        this._sessions = JSON.parse(sessionsData);
      } catch {
        this._sessions = [];
      }
    }
  }

  private async storeSessions(): Promise<void> {
    await this.context.secrets.store(
      AliaAuthenticationProvider.SESSIONS_KEY,
      JSON.stringify(this._sessions)
    );
  }

  /**
   * Sync the authentication session with the API key stored in settings.
   * If an API key exists, create or update a session.
   * If no API key, remove any existing session.
   */
  private async syncSessionWithApiKey(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codea');
    const apiKey = config.get<string>('apiKey', '');

    if (apiKey) {
      // Validate API key format
      if (!apiKey.startsWith('alia_sk_')) {
        return; // Invalid API key format, don't create session
      }

      // Check if we already have a session with this API key
      const existingSession = this._sessions.find(s => s.accessToken === apiKey);
      if (existingSession) {
        return; // Session already exists
      }

      // Create new session
      const session = await this.createSessionFromApiKey(apiKey);
      const added = [session];
      const removed = this._sessions.filter(s => s.accessToken !== apiKey);

      this._sessions = [session];
      await this.storeSessions();

      this._sessionChangeEmitter.fire({ added, removed, changed: [] });
    } else {
      // No API key, remove all sessions
      if (this._sessions.length > 0) {
        const removed = [...this._sessions];
        this._sessions = [];
        await this.storeSessions();
        this._sessionChangeEmitter.fire({ added: [], removed, changed: [] });
      }
    }
  }

  private async createSessionFromApiKey(apiKey: string): Promise<vscode.AuthenticationSession> {
    // Extract account info from API key or fetch from API
    const accountId = this.getAccountIdFromApiKey(apiKey);
    const accountLabel = await this.getAccountLabel(apiKey);

    return {
      id: `alia-session-${Date.now()}`,
      accessToken: apiKey,
      account: {
        id: accountId,
        label: accountLabel,
      },
      scopes: [], // Alia doesn't use scopes
    };
  }

  private getAccountIdFromApiKey(apiKey: string): string {
    // Extract a unique ID from the API key
    // Format: alia_sk_<user_id>_<random>
    const parts = apiKey.split('_');
    if (parts.length >= 3) {
      return parts[2]; // Return user ID part
    }
    return 'alia-user';
  }

  private async getAccountLabel(apiKey: string): Promise<string> {
    try {
      // Try to fetch user info from the API
      const config = vscode.workspace.getConfiguration('codea');
      const baseUrl = config.get<string>('apiBaseUrl', 'https://api.alia.onl');

      const response = await fetch(`${baseUrl}/user`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (response.ok) {
        const data = await response.json() as { username?: string; email?: string; name?: string };
        return data.username || data.email || data.name || 'Alia User';
      }
    } catch {
      // Ignore errors, use default label
    }
    return 'Alia User';
  }

  async getSessions(scopes?: string[]): Promise<vscode.AuthenticationSession[]> {
    await this.loadSessions();
    return this._sessions;
  }

  async createSession(scopes: string[]): Promise<vscode.AuthenticationSession> {
    // Prompt user for API key
    const apiKey = await vscode.window.showInputBox({
      prompt: 'Enter your Alia API key (starts with alia_sk_)',
      password: true,
      placeHolder: 'alia_sk_...',
      validateInput: (value) => {
        if (value && !value.startsWith('alia_sk_')) {
          return 'API key must start with alia_sk_';
        }
        return null;
      },
    });

    if (!apiKey) {
      throw new Error('API key is required');
    }

    // Save to settings
    await vscode.workspace.getConfiguration('codea').update(
      'apiKey',
      apiKey,
      vscode.ConfigurationTarget.Global
    );

    // Create and return session
    const session = await this.createSessionFromApiKey(apiKey);
    this._sessions = [session];
    await this.storeSessions();

    this._sessionChangeEmitter.fire({
      added: [session],
      removed: [],
      changed: [],
    });

    vscode.window.showInformationMessage('Signed in to Alia successfully!');
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const sessionIndex = this._sessions.findIndex(s => s.id === sessionId);
    if (sessionIndex !== -1) {
      const removed = this._sessions.splice(sessionIndex, 1);
      await this.storeSessions();

      // Also clear the API key from settings
      await vscode.workspace.getConfiguration('codea').update(
        'apiKey',
        undefined,
        vscode.ConfigurationTarget.Global
      );

      this._sessionChangeEmitter.fire({
        added: [],
        removed,
        changed: [],
      });
    }
  }

  dispose() {
    this._disposable.dispose();
    this._sessionChangeEmitter.dispose();
  }
}
