import * as vscode from 'vscode';
import type OpenAI from 'openai';
import { fileTools, ToolExecutor, type EditorContext } from './tools';
import type { AliaAuthenticationProvider } from './authProvider';
import { errorMessage, errorName } from './errors';
import { log } from './logger';
import { PREFERRED_MODEL_ID } from './config';
import { fetchOfferedModes, resolveModelId } from './catalogue';
import {
  AliaChatError,
  completedToolCalls,
  mergeToolCallDeltas,
  streamAliaChat,
  type AliaStreamEvent,
  type StreamedToolCall,
} from './aliaChat';

/**
 * The webview chat: Alia's product runtime, driven from the extension host.
 *
 * Streams `POST /alia/chat` through `./aliaChat` and runs the editor tools the
 * model asks for in this VS Code window. The webview is a display — it
 * receives `startAssistantMessage`, `streamContent`, `toolCall`, `toolResult`,
 * `modeChanged`, `clearStream`, `error` and `endAssistantMessage` — and never
 * holds the token.
 *
 * ## One loop, not two
 *
 * This file used to carry two copies of the same ~150-line turn —
 * `streamChatCompletion` for the first request and `continueWithToolResults`
 * for every request after a tool round — over the `openai` package. They had
 * already drifted (one truncated tool output with an ellipsis, the other
 * without; one logged an unparsable tool argument, the other dropped it
 * silently), and both left a tool call with malformed arguments WITHOUT a
 * `tool` message, which the next request was refused for. A turn is one loop
 * now: stream, collect tool calls, run them, repeat until the model answers in
 * text or the round budget is spent.
 *
 * ## The stand-in
 *
 * The server never sends a raw failure mid-answer: when every provider is busy
 * or one dies part-way it streams a friendly sentence flagged
 * `alia_meta.synthetic` (`packages/api/src/routes/v1/chat-completions.ts`).
 * `./aliaChat` surfaces that as its own event, so it is retried once and then
 * reported as a retryable error — never rendered as the answer and never
 * remembered as one. The list of English and Spanish phrases this file used to
 * match against is gone: the marker is the contract
 * (`routes/v1/__tests__/chatFlowFixtures.test.ts`, fixture 3), and a phrase
 * list is a copy of server text that goes stale the first time it is reworded.
 */

/**
 * The terminal `executedCommands` history is a proposed VS Code API not present in
 * the stable `TerminalShellIntegration` type, so we describe the shape we read.
 */
interface ShellExecutionRecord {
  commandLine?: string;
  read(): Promise<string>;
}
interface ExtendedShellIntegration {
  executedCommands?: ShellExecutionRecord[];
}

/**
 * How many tool rounds one user message may take before the model is told to
 * answer with what it has. The server bounds its own steps the same way
 * (`stopWhen: stepCountIs(5)` in `lib/chat/model-config.ts`).
 */
const MAX_TOOL_ROUNDS = 10;

/** What one streamed request produced, after the stream closed. */
interface StreamOutcome {
  text: string;
  toolCalls: StreamedToolCall[];
  /** The server sent a stand-in instead of (or after) an answer. */
  synthetic: { retryable: boolean } | null;
}

interface Conversation {
  id: string;
  title: string;
  messages: Array<OpenAI.Chat.ChatCompletionMessageParam>;
  createdAt: number;
  updatedAt: number;
}

export class CodeaChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codea.chatView';
  private _view?: vscode.WebviewView;
  private _messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = [];
  private _currentConversationId: string | null = null;
  private _abortController?: AbortController;
  private _userName: string | null = null;
  private _toolExecutor: ToolExecutor;
  private _isProcessing: boolean = false;
  private _currentMode: string = 'ask';
  private _lastRequestParams: { baseUrl: string; accessToken: string; model: string; clientContext: string } | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    private readonly _authProvider: AliaAuthenticationProvider
  ) {
    this._toolExecutor = new ToolExecutor();

    // Re-fetch user info when auth state changes (sign-in/sign-out)
    this._authProvider.onDidChangeSessions(() => {
      this.fetchAndSendUserInfo();
    });
  }

  private async fetchAndSendUserInfo(): Promise<void> {
    const accessToken = await this._authProvider.getAccessToken();

    if (!accessToken) {
      this._view?.webview.postMessage({ type: 'userInfo', userName: null });
      return;
    }

    try {
      const oxyServices = this._authProvider.getOxyServices();
      const userInfo = await oxyServices.getCurrentUser();
      // Prefer the canonical API-composed display name on `name.displayName`;
      // do not recompute from first/last.
      const displayName = (userInfo.name as { displayName?: string } | undefined)?.displayName;
      this._userName = displayName || userInfo.username || userInfo.email?.split('@')[0] || null;
      this._view?.webview.postMessage({ type: 'userInfo', userName: this._userName });
    } catch {
      this._view?.webview.postMessage({ type: 'userInfo', userName: null });
    }
  }

  /**
   * Send the webview what the product offers, in the product's own words.
   *
   * The webview holds no list of its own — it used to hardcode one, and
   * `GET /v1/models` has been permanently empty since #178
   * (`docs/migration/compatibility-window.md`), so that hardcoded entry was
   * what every user actually saw. An empty list here means the picker offers
   * nothing and the extension's `codea.model` setting stays in charge, which
   * is the honest answer when the catalogue cannot be read.
   *
   * The token is the extension host's, and it never reaches the webview: only
   * the identifiers and the words go across.
   */
  private async fetchAndSendModes(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codea');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.alia.onl';
    const accessToken = await this._authProvider.getAccessToken().catch(() => null);

    const modes = await fetchOfferedModes(baseUrl, accessToken ?? undefined);
    this._view?.webview.postMessage({ type: 'modes', modes });
  }

  private async handleSignOut(): Promise<void> {
    const sessions = await this._authProvider.getSessions();
    if (sessions.length > 0) {
      await this._authProvider.removeSession(sessions[0].id);
    }
    this._userName = null;
    this._view?.webview.postMessage({ type: 'userInfo', userName: null });
    vscode.window.showInformationMessage('Signed out of Codea');
  }

  private async handleRetry(): Promise<void> {
    if (this._isProcessing || !this._lastRequestParams) return;

    // Remove the last assistant message if it was an error (it won't be in _messages
    // because synthetic errors are not pushed, but clear any leftover state)
    this._isProcessing = true;
    const { baseUrl, accessToken, model, clientContext } = this._lastRequestParams;
    await this.processConversation(baseUrl, accessToken, model, clientContext);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    this.fetchAndSendUserInfo();
    this.fetchAndSendModes();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          await this.handleUserMessage(data.message, data.mode, data.model, data.context);
          break;
        case 'stopGeneration':
          this.stopGeneration();
          break;
        case 'newConversation':
          this.newConversation();
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'codea');
          break;
        case 'showHistory':
          await this.showConversationHistory();
          break;
        case 'addContext':
          await this.handleAddContext();
          break;
        case 'retry':
          await this.handleRetry();
          break;
        case 'signIn':
          vscode.commands.executeCommand('codea.signIn');
          break;
        case 'signOut':
          await this.handleSignOut();
          break;
      }
    });
  }

  private getConversations(): Conversation[] {
    return this._context.globalState.get<Conversation[]>('codea.conversations', []);
  }

  private saveConversations(conversations: Conversation[]): void {
    this._context.globalState.update('codea.conversations', conversations);
  }

  private saveCurrentConversation(): void {
    if (this._messages.length === 0) return;

    const conversations = this.getConversations();

    const firstUserMessage = this._messages.find(m => m.role === 'user');
    const title = firstUserMessage && 'content' in firstUserMessage && typeof firstUserMessage.content === 'string'
      ? firstUserMessage.content.slice(0, 50) + (firstUserMessage.content.length > 50 ? '...' : '')
      : 'New conversation';

    if (this._currentConversationId) {
      const index = conversations.findIndex(c => c.id === this._currentConversationId);
      if (index !== -1) {
        conversations[index].messages = [...this._messages];
        conversations[index].title = title;
        conversations[index].updatedAt = Date.now();
      }
    } else {
      this._currentConversationId = Date.now().toString();
      conversations.unshift({
        id: this._currentConversationId,
        title,
        messages: [...this._messages],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    if (conversations.length > 50) {
      conversations.splice(50);
    }

    this.saveConversations(conversations);
  }

  private async handleAddContext(): Promise<void> {
    const items: vscode.QuickPickItem[] = [];
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor && !activeEditor.selection.isEmpty) {
      const selectedText = activeEditor.document.getText(activeEditor.selection);
      const lineCount = selectedText.split('\n').length;
      items.push({
        label: '$(selection) Selection',
        description: `${lineCount} line${lineCount > 1 ? 's' : ''} selected`,
        detail: 'Add the currently selected text'
      });
    }

    if (activeEditor) {
      const relativePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      items.push({
        label: '$(file) Current File',
        description: relativePath,
        detail: 'Add the currently open file to context'
      });
    }

    const allDiagnostics = vscode.languages.getDiagnostics();
    const errorCount = allDiagnostics.reduce((sum, [, diags]) =>
      sum + diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length, 0);
    const warningCount = allDiagnostics.reduce((sum, [, diags]) =>
      sum + diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length, 0);
    if (errorCount > 0 || warningCount > 0) {
      items.push({
        label: '$(error) Problems',
        description: `${errorCount} errors, ${warningCount} warnings`,
        detail: 'Add current problems and diagnostics'
      });
    }

    items.push({
      label: '$(git-commit) Git Changes',
      description: 'Staged and unstaged changes',
      detail: 'Add current git diff to context'
    });

    const activeTerminal = vscode.window.activeTerminal;
    if (activeTerminal) {
      items.push({
        label: '$(terminal) Terminal',
        description: activeTerminal.name,
        detail: 'Add last command output (requires shell integration)'
      });
    }

    items.push({
      label: '$(folder) Browse Files...',
      description: '',
      detail: 'Select files from your workspace'
    });

    const openTabs = vscode.window.tabGroups.all
      .flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputText)
      .map(tab => (tab.input as vscode.TabInputText).uri);

    if (openTabs.length > 0) {
      items.push({ label: 'Open Tabs', kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem);
    }

    for (const uri of openTabs.slice(0, 10)) {
      const relativePath = vscode.workspace.asRelativePath(uri);
      if (relativePath !== (activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri) : '')) {
        items.push({
          label: `$(file) ${relativePath.split('/').pop()}`,
          description: relativePath,
          detail: 'Open tab'
        });
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select context to add',
      canPickMany: true
    });

    if (!selected || selected.length === 0) return;

    const contextItems: { path: string; content: string; language: string }[] = [];

    for (const item of selected) {
      if (item.label === '$(selection) Selection') {
        if (activeEditor && !activeEditor.selection.isEmpty) {
          const selectedText = activeEditor.document.getText(activeEditor.selection);
          const relativePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
          const startLine = activeEditor.selection.start.line + 1;
          const endLine = activeEditor.selection.end.line + 1;
          contextItems.push({
            path: `Selection (${relativePath}:${startLine}-${endLine})`,
            content: selectedText,
            language: activeEditor.document.languageId
          });
        }
      } else if (item.label === '$(error) Problems') {
        const diagnosticsText = this.formatDiagnostics(allDiagnostics);
        contextItems.push({
          path: 'Problems',
          content: diagnosticsText,
          language: 'text'
        });
      } else if (item.label === '$(git-commit) Git Changes') {
        try {
          const gitDiff = await this.getGitDiff();
          if (gitDiff) {
            contextItems.push({
              path: 'Git Changes',
              content: gitDiff,
              language: 'diff'
            });
          }
        } catch (e) {
          // Git not available
        }
      } else if (item.label === '$(terminal) Terminal') {
        const terminal = vscode.window.activeTerminal;
        if (terminal) {
          try {
            const shellIntegration = terminal.shellIntegration as ExtendedShellIntegration | undefined;
            const executedCommands = shellIntegration?.executedCommands;
            if (executedCommands && executedCommands.length > 0) {
              const execution = executedCommands[executedCommands.length - 1];
              if (execution) {
                const output = await execution.read();
                if (output) {
                  contextItems.push({
                    path: `Terminal: ${execution.commandLine || 'last command'}`,
                    content: output.slice(0, 10000) + (output.length > 10000 ? '\n... (truncated)' : ''),
                    language: 'text'
                  });
                }
              }
            } else {
              const selection = await vscode.window.showInputBox({
                prompt: 'Paste terminal output here (shell integration not available)',
                placeHolder: 'Paste your terminal output...',
                ignoreFocusOut: true
              });
              if (selection) {
                contextItems.push({
                  path: 'Terminal Output',
                  content: selection,
                  language: 'text'
                });
              }
            }
          } catch (e) {
            const selection = await vscode.window.showInputBox({
              prompt: 'Paste terminal output here',
              placeHolder: 'Paste your terminal output...',
              ignoreFocusOut: true
            });
            if (selection) {
              contextItems.push({
                path: 'Terminal Output',
                content: selection,
                language: 'text'
              });
            }
          }
        }
      } else if (item.label === '$(folder) Browse Files...') {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Add to Context',
          filters: { 'All Files': ['*'] }
        });
        if (files) {
          for (const file of files) {
            try {
              const doc = await vscode.workspace.openTextDocument(file);
              contextItems.push({
                path: vscode.workspace.asRelativePath(file),
                content: doc.getText(),
                language: doc.languageId
              });
            } catch (e) {
              // Skip unreadable files
            }
          }
        }
      } else if (item.label === '$(file) Current File') {
        if (activeEditor) {
          contextItems.push({
            path: vscode.workspace.asRelativePath(activeEditor.document.uri),
            content: activeEditor.document.getText(),
            language: activeEditor.document.languageId
          });
        }
      } else if (item.description && !item.label.startsWith('Open Tabs')) {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (workspaceFolder) {
            const uri = vscode.Uri.joinPath(workspaceFolder.uri, item.description);
            const doc = await vscode.workspace.openTextDocument(uri);
            contextItems.push({
              path: item.description,
              content: doc.getText(),
              language: doc.languageId
            });
          }
        } catch (e) {
          // Skip unreadable files
        }
      }
    }

    if (contextItems.length > 0) {
      this._view?.webview.postMessage({
        type: 'contextAdded',
        items: contextItems
      });
    }
  }

  private formatDiagnostics(diagnostics: [vscode.Uri, vscode.Diagnostic[]][]): string {
    const lines: string[] = [];

    for (const [uri, diags] of diagnostics) {
      if (diags.length === 0) continue;

      const relativePath = vscode.workspace.asRelativePath(uri);
      lines.push(`## ${relativePath}`);

      for (const diag of diags) {
        const severity = diag.severity === vscode.DiagnosticSeverity.Error ? 'Error' :
                        diag.severity === vscode.DiagnosticSeverity.Warning ? 'Warning' :
                        diag.severity === vscode.DiagnosticSeverity.Information ? 'Info' : 'Hint';
        const line = diag.range.start.line + 1;
        const col = diag.range.start.character + 1;
        const source = diag.source ? `[${diag.source}] ` : '';
        lines.push(`- ${severity} (${line}:${col}): ${source}${diag.message}`);
      }
      lines.push('');
    }

    return lines.length > 0 ? lines.join('\n') : 'No problems found.';
  }

  private async getGitDiff(): Promise<string | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    if (typeof process === 'undefined' || !process.versions?.node) {
      return 'Git diff is not available in web environment.';
    }

    return new Promise((resolve) => {
      const cp = require('child_process');
      cp.exec('git diff HEAD', { cwd: workspaceFolder.uri.fsPath, maxBuffer: 1024 * 1024 }, (error: Error | null, stdout: string) => {
        if (error) {
          cp.exec('git diff', { cwd: workspaceFolder.uri.fsPath, maxBuffer: 1024 * 1024 }, (error2: Error | null, stdout2: string) => {
            if (error2 || !stdout2) {
              resolve(null);
            } else {
              resolve(stdout2.slice(0, 10000) + (stdout2.length > 10000 ? '\n... (truncated)' : ''));
            }
          });
        } else if (stdout) {
          resolve(stdout.slice(0, 10000) + (stdout.length > 10000 ? '\n... (truncated)' : ''));
        } else {
          resolve('No changes detected.');
        }
      });
    });
  }

  private async showConversationHistory(): Promise<void> {
    const conversations = this.getConversations();

    if (conversations.length === 0) {
      vscode.window.showInformationMessage('No past conversations yet.');
      return;
    }

    const items = conversations.map(c => ({
      label: c.title,
      description: new Date(c.updatedAt).toLocaleDateString(),
      detail: `${c.messages.length} messages`,
      conversation: c
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a conversation to restore',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (selected) {
      this.loadConversation(selected.conversation);
    }
  }

  private loadConversation(conversation: Conversation): void {
    this._currentConversationId = conversation.id;
    this._messages = [...conversation.messages];

    this._view?.webview.postMessage({ type: 'clearChat' });

    for (const message of this._messages) {
      this._view?.webview.postMessage({
        type: 'addMessage',
        message
      });
    }
  }

  public newConversation() {
    this.saveCurrentConversation();
    this._currentConversationId = null;
    this._messages = [];
    this._view?.webview.postMessage({ type: 'clearChat' });
  }

  public clearConversation() {
    this.stopGeneration();
    this.newConversation();
  }

  private stopGeneration() {
    this._isProcessing = false;
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = undefined;
    }
    this._view?.webview.postMessage({ type: 'endAssistantMessage' });
  }

  private async handleUserMessage(content: string, mode: string = 'ask', selectedModel?: string, addedContext?: { path: string; content: string; language: string }[]) {
    if (this._isProcessing) return;

    if (mode) {
      this._currentMode = mode;
    }

    const config = vscode.workspace.getConfiguration('codea');
    const accessToken = await this._authProvider.getAccessToken();
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.alia.onl';
    /**
     * Resolved once here, then carried through the whole conversation —
     * including `_lastRequestParams`, which replays it after a tool round. The
     * alternative, resolving inside `streamChatCompletion`, would re-resolve on
     * every continuation and could change model mid-conversation if the
     * catalogue shifted underneath it.
     */
    const requestedModel = selectedModel || config.get<string>('model') || PREFERRED_MODEL_ID;
    const model = await resolveModelId(baseUrl, requestedModel, accessToken ?? undefined);

    if (!accessToken) {
      vscode.window.showErrorMessage(
        'Please sign in to use Codea',
        'Sign In'
      ).then(selection => {
        if (selection === 'Sign In') {
          vscode.commands.executeCommand('codea.signIn');
        }
      });
      return;
    }

    const context = await this._toolExecutor.getContext();

    // Build client-specific context to send to backend
    const clientContext = this.buildClientContext(this._currentMode, context);

    let enhancedContent = content;

    if (addedContext && addedContext.length > 0) {
      for (const item of addedContext) {
        const fileContent = item.content.slice(0, 4000);
        const truncated = item.content.length > 4000 ? '\n... (truncated)' : '';
        enhancedContent += `\n\n**File: ${item.path}**\n\`\`\`${item.language}\n${fileContent}${truncated}\n\`\`\``;
      }
    }

    if (!addedContext || addedContext.length === 0) {
      const referencesCode = /\b(this|the|explain|review|fix|debug|code|file|function|error|codebase|project)\b/i.test(content);

      if (referencesCode && context.selection) {
        enhancedContent = `${content}\n\n**Selected code (${context.openFile?.path || 'unknown'}, lines ${context.selection.startLine}-${context.selection.endLine}):**\n\`\`\`${context.openFile?.language || ''}\n${context.selection.text}\n\`\`\``;
      } else if (referencesCode && context.openFile) {
        const fileContent = context.openFile.content.slice(0, 4000);
        const truncated = context.openFile.content.length > 4000 ? '\n... (truncated)' : '';
        enhancedContent = `${content}\n\n**Currently open file (${context.openFile.path}):**\n\`\`\`${context.openFile.language}\n${fileContent}${truncated}\n\`\`\``;
      }
    }

    this._messages.push({ role: 'user', content: enhancedContent });
    this._view?.webview.postMessage({
      type: 'addMessage',
      message: { role: 'user', content }
    });

    this._isProcessing = true;
    this._lastRequestParams = { baseUrl, accessToken, model, clientContext };
    await this.processConversation(baseUrl, accessToken, model, clientContext);
  }

  private buildClientContext(mode: string, context: EditorContext): string {
    // Build VS Code specific context to send to the backend
    let clientContext = `# VS Code Editor Context

You are running inside Visual Studio Code, Microsoft's popular code editor.

## Editor Tools Available
- **read_file** - Read file contents from the workspace
- **write_file** - Create new files or completely overwrite existing ones
- **edit_file** - Make precise text replacements in existing files
- **open_file** - Open files in VS Code editor tabs
- **delete_file** - Delete files from the workspace
- **list_files** - List directory contents with optional patterns
- **search_files** - Search for text patterns across the workspace
- **run_command** - Execute shell commands in the workspace terminal

## Current Operating Mode: ${mode.toUpperCase()}`;

    if (mode === 'ask') {
      clientContext += `
- Confirm only DESTRUCTIVE operations (delete files, overwrite important files)
- Execute all other operations immediately`;
    } else if (mode === 'edit') {
      clientContext += `
- Make ALL changes directly without any confirmation
- User trusts you to make modifications`;
    } else if (mode === 'plan') {
      clientContext += `
- Design complete implementation plan first
- Ask for approval ONCE
- Then execute entire plan without further questions`;
    } else if (mode === 'yolo') {
      clientContext += `
- Full autonomous mode
- ZERO confirmations for anything
- Maximum automation`;
    }

    // Add workspace context
    if (context.workspaceStructure) {
      clientContext += `\n\n=== WORKSPACE STRUCTURE ===\n\`\`\`\n${context.workspaceStructure}\n\`\`\``;
    }

    if (context.openTabs && context.openTabs.length > 0) {
      clientContext += `\n\n=== CURRENTLY OPEN FILES ===\n${context.openTabs.map((f) => `- ${f}`).join('\n')}`;
    }

    if (context.openFile) {
      clientContext += `\n\n=== ACTIVE EDITOR ===\nFile: ${context.openFile.path}\nLanguage: ${context.openFile.language || 'unknown'}`;
    }

    return clientContext;
  }

  /**
   * One user message, to completion: stream, run tools, stream again.
   *
   * `accessToken` is the token the caller read; a 401 is retried once on a
   * freshly minted one and the fresh token is used for the rest of the turn.
   * The final round is sent with `tool_choice: 'none'` so a model that would
   * keep calling tools is made to answer instead of being cut off silently.
   */
  private async processConversation(baseUrl: string, accessToken: string, model: string, clientContext: string): Promise<void> {
    this._view?.webview.postMessage({ type: 'startAssistantMessage' });
    this._abortController = new AbortController();

    let currentToken = accessToken;
    let retriedSynthetic = false;

    /**
     * The client context rides as the system message of EVERY request. The
     * server replaces it with its complete prompt and folds this text in as
     * client context (`lib/chat/request-context.ts`), so sending it only on
     * the first request — as this used to — left every tool-round
     * continuation without the editor's mode and workspace.
     */
    const request = (finalRound: boolean) => ({
      model,
      messages: [{ role: 'system' as const, content: clientContext }, ...this._messages],
      tools: finalRound ? undefined : (fileTools as OpenAI.Chat.ChatCompletionTool[]),
      ...(finalRound ? { tool_choice: 'none' as const } : {}),
      temperature: 0.7,
      max_tokens: 4096,
    });

    const streamOnce = async (finalRound: boolean): Promise<StreamOutcome> => {
      const attempt = (token: string) =>
        this.consume(streamAliaChat({ baseUrl, accessToken: token, body: request(finalRound), signal: this._abortController?.signal }));
      try {
        return await attempt(currentToken);
      } catch (error: unknown) {
        if (!(error instanceof AliaChatError) || error.status !== 401) throw error;
        // On 401, re-mint once and retry. `getAccessToken` refreshes a stale
        // token itself; this is for a token the server rejected regardless.
        const refreshed = await this._authProvider.refreshToken();
        const fresh = refreshed ? await this._authProvider.getAccessToken() : null;
        if (!fresh || fresh === currentToken) throw error;
        currentToken = fresh;
        return await attempt(currentToken);
      }
    };

    try {
      for (let round = 0; this._isProcessing; round++) {
        const lastRound = round >= MAX_TOOL_ROUNDS;
        if (lastRound) log.warn(`[Codea] Max tool rounds (${MAX_TOOL_ROUNDS}) reached, forcing final response`);

        const outcome = await streamOnce(lastRound);

        if (outcome.synthetic !== null) {
          if (!retriedSynthetic) {
            // Once, after a short wait: the busy stand-in is usually momentary.
            retriedSynthetic = true;
            log.info('[Codea] Synthetic response detected, retrying in 2s...');
            this._view?.webview.postMessage({ type: 'clearStream' });
            await new Promise((resolve) => setTimeout(resolve, 2000));
            round--;
            continue;
          }
          this._view?.webview.postMessage({
            type: 'error',
            message: 'The service is temporarily unavailable. Please try again.',
            retryable: true,
          });
          return;
        }

        if (outcome.text || outcome.toolCalls.length > 0) {
          const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: outcome.text || null,
          };
          if (outcome.toolCalls.length > 0) assistant.tool_calls = outcome.toolCalls;
          this._messages.push(assistant);
        }

        if (outcome.toolCalls.length === 0 || lastRound) break;

        for (const toolCall of outcome.toolCalls) {
          if (!this._isProcessing) break;
          await this.runToolCall(toolCall);
        }
      }

      this._view?.webview.postMessage({ type: 'endAssistantMessage' });
    } catch (error: unknown) {
      if (errorName(error) !== 'AbortError') {
        const errorMsg = this.formatErrorMessage(error);
        this._view?.webview.postMessage({
          type: 'error',
          message: errorMsg,
          retryable: error instanceof AliaChatError && error.retryable,
        });
        vscode.window.showErrorMessage(`Codea: ${errorMsg}`);
      }
    } finally {
      this._isProcessing = false;
      this.saveCurrentConversation();
    }
  }

  /** Forward a stream to the webview and collect what the history needs. */
  private async consume(stream: AsyncIterable<AliaStreamEvent>): Promise<StreamOutcome> {
    let text = '';
    const toolCalls: StreamedToolCall[] = [];
    let synthetic: StreamOutcome['synthetic'] = null;

    for await (const event of stream) {
      // `stopGeneration` aborts the controller, which ends the iteration with
      // an AbortError; this is the guard for the frames already in flight.
      if (!this._isProcessing) break;

      switch (event.type) {
        case 'content':
          text += event.text;
          this._view?.webview.postMessage({ type: 'streamContent', content: event.text });
          break;
        case 'tool_calls':
          mergeToolCallDeltas(toolCalls, event.deltas);
          break;
        case 'synthetic':
          log.warn('[Codea] Server sent a synthetic stand-in:', event.text);
          synthetic = { retryable: event.retryable };
          break;
        case 'reasoning':
        case 'tool_result':
        case 'finish':
        case 'event':
          // The webview has no reasoning surface; a tool result for one of
          // this extension's own tools is the server's echo of the arguments,
          // and the real result comes from `runToolCall`.
          break;
      }
    }

    return { text, toolCalls: completedToolCalls(toolCalls), synthetic };
  }

  /** Execute one tool call in this window and append its result to the history. */
  private async runToolCall(toolCall: StreamedToolCall): Promise<void> {
    const toolName = toolCall.function.name;

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
    } catch (e) {
      log.error('[Codea] Failed to parse tool arguments:', toolCall.function.arguments, e);
      // The model is told rather than left waiting for a result that never
      // comes: a `tool_calls` entry with no matching `tool` message is a
      // request the server refuses.
      this._messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: 'Error: Malformed tool arguments. Please retry with valid JSON.',
      });
      this._view?.webview.postMessage({ type: 'toolResult', tool: toolName, success: false, result: 'Malformed tool arguments' });
      return;
    }

    if (toolName === 'set_mode') {
      this._currentMode = String(args.mode ?? this._currentMode);
      this._view?.webview.postMessage({ type: 'modeChanged', mode: this._currentMode });
    }

    this._view?.webview.postMessage({ type: 'toolCall', tool: toolName, args, status: 'running' });

    try {
      const result = await this._toolExecutor.execute(toolName, args);

      this._messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result.success ? result.result : `Error: ${result.result}`,
      });

      this._view?.webview.postMessage({
        type: 'toolResult',
        tool: toolName,
        success: result.success,
        result: result.result.slice(0, 500) + (result.result.length > 500 ? '...' : ''),
      });
    } catch (error: unknown) {
      const errorMsg = errorMessage(error);
      this._messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error: ${errorMsg}` });
      this._view?.webview.postMessage({ type: 'toolResult', tool: toolName, success: false, result: errorMsg });
    }
  }

  /**
   * What the webview shows for a failure.
   *
   * A structured refusal carries its own message and, where the server sent
   * one, a code — `MODEL_NOT_IN_PLAN` reads "Upgrade your plan to use this
   * model." exactly as the server wrote it. The status branches are for the
   * refusals whose server message is not written for a person.
   */
  private formatErrorMessage(error: unknown): string {
    if (error instanceof AliaChatError) {
      switch (error.status) {
        case 401:
          return 'Authentication failed. Please sign in again using the "Codea: Sign In" command.';
        case 402:
          return 'Insufficient credits. Please add more credits at alia.onl';
        case 429:
          return 'Rate limit exceeded. Please wait a moment and try again.';
        case 500:
          return 'Server error. Please try again later.';
        case 502:
        case 503:
        case 504:
          return 'Service unavailable. Please try again later.';
        default:
          return error.message;
      }
    }

    const message = errorMessage(error, 'An error occurred');
    if (message.toLowerCase().includes('insufficient credits')) {
      return 'Insufficient credits. Please add more credits at alia.onl';
    }
    if (message.toLowerCase().includes('rate limit')) {
      return 'Rate limit exceeded. Please wait a moment and try again.';
    }
    return message;
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.css'));
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'codea-logo.png'));

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} https: data:; connect-src https:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Codea</title>
  <script nonce="${nonce}">
    window.CODEA_LOGO_URI = "${logoUri}";
  </script>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
