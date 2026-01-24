import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { fileTools, ToolExecutor } from './tools';

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      role?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export class CodeaChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codea.chatView';
  private _view?: vscode.WebviewView;
  private _messages: Message[] = [];
  private _currentConversationId: string | null = null;
  private _currentRequest?: { abort: () => void };
  private _userName: string | null = null;
  private _toolExecutor: ToolExecutor;
  private _isProcessing: boolean = false;
  private _currentMode: string = 'ask';

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._toolExecutor = new ToolExecutor();
  }

  private async fetchAndSendUserInfo(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codea');
    const apiKey = config.get<string>('apiKey');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.alia.onl';

    if (!apiKey) {
      this._view?.webview.postMessage({ type: 'userInfo', userName: null });
      return;
    }

    try {
      const userInfo = await this.fetchUserInfo(baseUrl, apiKey);
      // API returns full user object - use same fallback chain as app
      this._userName = userInfo?.name?.first || userInfo?.username || userInfo?.email?.split('@')[0] || null;
      this._view?.webview.postMessage({ type: 'userInfo', userName: this._userName });
    } catch (error) {
      this._view?.webview.postMessage({ type: 'userInfo', userName: null });
    }
  }

  private async fetchAndSendModels(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codea');
    const apiKey = config.get<string>('apiKey');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.alia.onl';

    console.log('[Codea] Fetching models from:', baseUrl);

    // Models endpoint is public, no API key needed
    try {
      const models = await this.fetchModels(baseUrl);
      console.log('[Codea] Fetched models:', models.length, models.map((m: any) => m.id));
      this._view?.webview.postMessage({ type: 'models', models });
    } catch (error) {
      console.error('[Codea] Error fetching models:', error);
      this._view?.webview.postMessage({ type: 'models', models: [] });
    }
  }

  private fetchModels(baseUrl: string): Promise<any[]> {
    return new Promise((resolve) => {
      const url = new URL(`${baseUrl}/v1/models?category=coding`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET'
      };

      console.log('[Codea] Fetching models from URL:', url.toString());

      const req = httpModule.request(options, (res) => {
        console.log('[Codea] Models response status:', res.statusCode);
        if (res.statusCode !== 200) {
          resolve([]);
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            console.log('[Codea] Models response parsed, count:', parsed.data?.length);
            resolve(parsed.data || []);
          } catch (e) {
            console.error('[Codea] Failed to parse models response:', e);
            resolve([]);
          }
        });
      });

      req.on('error', (e) => {
        console.error('[Codea] Models request error:', e);
        resolve([]);
      });
      req.end();
    });
  }

  private fetchUserInfo(baseUrl: string, apiKey: string): Promise<{ id?: string; name?: { first?: string; last?: string; full?: string }; username?: string; email?: string; avatar?: string } | null> {
    return new Promise((resolve) => {
      const url = new URL(`${baseUrl}/v1/codea/me`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      };

      const req = httpModule.request(options, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.end();
    });
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

    // Fetch and send user info and models to webview
    this.fetchAndSendUserInfo();
    this.fetchAndSendModels();

    // Handle messages from webview
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

    // Generate title from first user message
    const firstUserMessage = this._messages.find(m => m.role === 'user');
    const title = firstUserMessage
      ? firstUserMessage.content.slice(0, 50) + (firstUserMessage.content.length > 50 ? '...' : '')
      : 'New conversation';

    if (this._currentConversationId) {
      // Update existing conversation
      const index = conversations.findIndex(c => c.id === this._currentConversationId);
      if (index !== -1) {
        conversations[index].messages = [...this._messages];
        conversations[index].title = title;
        conversations[index].updatedAt = Date.now();
      }
    } else {
      // Create new conversation
      this._currentConversationId = Date.now().toString();
      conversations.unshift({
        id: this._currentConversationId,
        title,
        messages: [...this._messages],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    // Keep only last 50 conversations
    if (conversations.length > 50) {
      conversations.splice(50);
    }

    this.saveConversations(conversations);
  }

  private async handleAddContext(): Promise<void> {
    // Show quick pick with context options
    const items: vscode.QuickPickItem[] = [];

    const activeEditor = vscode.window.activeTextEditor;

    // Add selection option if there's selected text
    if (activeEditor && !activeEditor.selection.isEmpty) {
      const selectedText = activeEditor.document.getText(activeEditor.selection);
      const lineCount = selectedText.split('\n').length;
      items.push({
        label: '$(selection) Selection',
        description: `${lineCount} line${lineCount > 1 ? 's' : ''} selected`,
        detail: 'Add the currently selected text'
      });
    }

    // Add currently open file if any
    if (activeEditor) {
      const relativePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      items.push({
        label: '$(file) Current File',
        description: relativePath,
        detail: 'Add the currently open file to context'
      });
    }

    // Add problems/diagnostics option
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

    // Add git changes option
    items.push({
      label: '$(git-commit) Git Changes',
      description: 'Staged and unstaged changes',
      detail: 'Add current git diff to context'
    });


    // Add terminal option - get last command output via shell integration
    const activeTerminal = vscode.window.activeTerminal;
    if (activeTerminal) {
      items.push({
        label: '$(terminal) Terminal',
        description: activeTerminal.name,
        detail: 'Add last command output (requires shell integration)'
      });
    }

    // Add option to browse files
    items.push({
      label: '$(folder) Browse Files...',
      description: '',
      detail: 'Select files from your workspace'
    });

    // Add separator and open tabs
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
        // Add selected text
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
        // Add problems/diagnostics
        const diagnosticsText = this.formatDiagnostics(allDiagnostics);
        contextItems.push({
          path: 'Problems',
          content: diagnosticsText,
          language: 'text'
        });
      } else if (item.label === '$(git-commit) Git Changes') {
        // Add git diff
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
        // Try to get terminal output via shell integration
        const terminal = vscode.window.activeTerminal;
        if (terminal) {
          try {
            // Shell integration API (VS Code 1.93+)
            const shellIntegration = (terminal as any).shellIntegration;
            if (shellIntegration) {
              const execution = shellIntegration.executedCommands?.[shellIntegration.executedCommands.length - 1];
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
              // Fallback: prompt user to copy output
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
            // Fallback: prompt user to copy output
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
        // Show file picker
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
        // Add current file
        if (activeEditor) {
          contextItems.push({
            path: vscode.workspace.asRelativePath(activeEditor.document.uri),
            content: activeEditor.document.getText(),
            language: activeEditor.document.languageId
          });
        }
      } else if (item.description && !item.label.startsWith('Open Tabs')) {
        // Get file content from open tabs
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

    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec('git diff HEAD', { cwd: workspaceFolder.uri.fsPath, maxBuffer: 1024 * 1024 }, (error: any, stdout: string) => {
        if (error) {
          // Try just unstaged changes
          exec('git diff', { cwd: workspaceFolder.uri.fsPath, maxBuffer: 1024 * 1024 }, (error2: any, stdout2: string) => {
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

    // Clear and reload the chat in webview
    this._view?.webview.postMessage({ type: 'clearChat' });

    // Send all messages to webview
    for (const message of this._messages) {
      this._view?.webview.postMessage({
        type: 'addMessage',
        message
      });
    }
  }

  public newConversation() {
    // Save current conversation before starting new one
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
    if (this._currentRequest) {
      this._currentRequest.abort();
      this._currentRequest = undefined;
    }
    // Reset the webview UI state
    this._view?.webview.postMessage({ type: 'endAssistantMessage' });
  }

  private async handleUserMessage(content: string, mode: string = 'ask', selectedModel?: string, addedContext?: { path: string; content: string; language: string }[]) {
    if (this._isProcessing) return;

    // Update current mode from UI selection
    if (mode) {
      this._currentMode = mode;
    }

    const config = vscode.workspace.getConfiguration('codea');
    const apiKey = config.get<string>('apiKey');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.alia.onl';
    const model = selectedModel || config.get<string>('model') || 'alia-v1-codea';

    if (!apiKey) {
      vscode.window.showErrorMessage(
        'Please set your Alia API key in settings (codea.apiKey)',
        'Open Settings'
      ).then(selection => {
        if (selection === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'codea.apiKey');
        }
      });
      return;
    }

    // Get current context (open file, selection)
    const context = await this._toolExecutor.getContext();

    // Debug: log what context we're getting
    console.log('[Codea] Context captured:', {
      hasOpenFile: !!context.openFile,
      openFilePath: context.openFile?.path,
      openFileLength: context.openFile?.content?.length,
      hasSelection: !!context.selection,
      openTabs: context.openTabs,
      addedContextCount: addedContext?.length || 0
    });

    // Build system message based on mode
    const systemMessage = this.buildSystemMessage(this._currentMode, context);

    // Enhance user message with context
    let enhancedContent = content;

    // First, add any explicitly added context files
    if (addedContext && addedContext.length > 0) {
      for (const item of addedContext) {
        const fileContent = item.content.slice(0, 4000);
        const truncated = item.content.length > 4000 ? '\n... (truncated)' : '';
        enhancedContent += `\n\n**File: ${item.path}**\n\`\`\`${item.language}\n${fileContent}${truncated}\n\`\`\``;
      }
      console.log('[Codea] Added explicit context:', addedContext.map(c => c.path));
    }

    // Then check if referencing code and add implicit context
    const referencesCode = /\b(this|the|explain|review|fix|debug|code|file|function|error|codebase|project)\b/i.test(content);

    // Debug log
    console.log('[Codea] Message analysis:', {
      content: content.substring(0, 50),
      referencesCode,
      hasSelection: !!context.selection,
      hasOpenFile: !!context.openFile,
      messageCount: this._messages.length,
      hasAddedContext: (addedContext?.length || 0) > 0
    });

    // Only add implicit context if no explicit context was added
    if (!addedContext || addedContext.length === 0) {
      if (referencesCode && context.selection) {
        // User has selected text - include it in their message
        enhancedContent = `${content}\n\n**Selected code (${context.openFile?.path || 'unknown'}, lines ${context.selection.startLine}-${context.selection.endLine}):**\n\`\`\`${context.openFile?.language || ''}\n${context.selection.text}\n\`\`\``;
        console.log('[Codea] Injecting selection context');
      } else if (referencesCode && context.openFile) {
        // Include open file context whenever referencing code (not just first message)
        const fileContent = context.openFile.content.slice(0, 4000);
        const truncated = context.openFile.content.length > 4000 ? '\n... (truncated)' : '';
        enhancedContent = `${content}\n\n**Currently open file (${context.openFile.path}):**\n\`\`\`${context.openFile.language}\n${fileContent}${truncated}\n\`\`\``;
        console.log('[Codea] Injecting open file context:', context.openFile.path);
      }
    }

    // Add user message (show original to user, send enhanced to API)
    this._messages.push({ role: 'user', content: enhancedContent });
    this._view?.webview.postMessage({
      type: 'addMessage',
      message: { role: 'user', content }  // Show original to user
    });

    // Start processing loop
    this._isProcessing = true;
    await this.processConversation(baseUrl, apiKey, model, systemMessage);
  }

  private buildSystemMessage(mode: string, context: any): string {
    let systemMessage = `You are Codea, an expert AI coding assistant. Be concise and action-oriented.

## Critical Rules
1. **NEVER ask follow-up questions** like "Would you like me to..." or "Shall I proceed?" - Just DO IT.
2. **NEVER show diffs** and ask for approval - Execute the change directly with tools.
3. **NEVER ask users to share code** - Use read_file tool to get it yourself.
4. **When user says "yes" or confirms** - Execute immediately, don't explain again.
5. **For simple tasks** (add text, edit file, list files) - Just do it in one step.

## Tools - USE THEM DIRECTLY
- **read_file**: Read file contents
- **write_file**: Create/overwrite files (use for appending text too)
- **edit_file**: Replace specific text in files (old_text must match EXACTLY including whitespace)
- **list_files**: List directory contents
- **search_files**: Search for patterns
- **run_command**: Run shell commands
- **set_mode**: Switch operating mode when user asks (e.g., "go edit mode", "switch to yolo")

## How to Edit Files
For small changes like "add hello to the end":
1. Read the file with read_file
2. Use write_file with the FULL content + your addition
Do NOT use edit_file unless you have the EXACT text to replace.

## Response Style
- Be brief. One sentence explanations max.
- Don't narrate what you're doing ("I'll read the file...") - just do it.
- After completing a task, briefly confirm what was done.`;

    if (mode === 'ask') {
      systemMessage += `\n\n## Mode: ASK (Current)
For DESTRUCTIVE operations only (delete, overwrite important files), briefly confirm. For everything else, just do it.`;
    } else if (mode === 'edit') {
      systemMessage += `\n\n## Mode: EDIT (Current)
Make changes directly. No confirmations needed.`;
    } else if (mode === 'plan') {
      systemMessage += `\n\n## Mode: PLAN (Current)
Outline steps first, then ask once for approval before executing all changes.`;
    } else if (mode === 'yolo') {
      systemMessage += `\n\n## Mode: YOLO (Current)
Full autonomous mode. Execute everything without any confirmations.`;
    }

    // Add workspace structure
    if (context.workspaceStructure) {
      systemMessage += `\n\n## Workspace Structure\n\`\`\`\n${context.workspaceStructure}\n\`\`\``;
    }

    // Add list of open tabs as context
    if (context.openTabs?.length > 0) {
      systemMessage += `\n\n## Currently Open Files\n${context.openTabs.join('\n')}`;
    }

    // Add current file info
    if (context.openFile) {
      systemMessage += `\n\n## Active File: ${context.openFile.path}`;
    }

    return systemMessage;
  }

  private async processConversation(baseUrl: string, apiKey: string, model: string, systemMessage: string): Promise<void> {
    let isFirstIteration = true;

    while (this._isProcessing) {
      // Start assistant response - only clear state on first iteration
      if (isFirstIteration) {
        this._view?.webview.postMessage({ type: 'startAssistantMessage' });
        isFirstIteration = false;
      }

      try {
        const result = await this.streamChatCompletion(baseUrl, apiKey, model, systemMessage, this._messages);

        if (!this._isProcessing) break;

        // Check if there are tool calls to process
        if (result.toolCalls && result.toolCalls.length > 0) {
          // Add assistant message with tool calls
          const assistantMessage: Message = {
            role: 'assistant',
            content: result.content,
            tool_calls: result.toolCalls
          };
          this._messages.push(assistantMessage);

          // Execute each tool call
          for (const toolCall of result.toolCalls) {
            if (!this._isProcessing) break;

            const args = JSON.parse(toolCall.function.arguments);

            // Notify UI about tool execution
            this._view?.webview.postMessage({
              type: 'toolCall',
              tool: toolCall.function.name,
              args: args,
              status: 'running'
            });

            let toolResult: { success: boolean; result: string };

            // Handle set_mode specially
            if (toolCall.function.name === 'set_mode') {
              const newMode = args.mode;
              if (['ask', 'edit', 'plan', 'yolo'].includes(newMode)) {
                this._currentMode = newMode;
                // Notify webview to update mode selector
                this._view?.webview.postMessage({
                  type: 'modeChanged',
                  mode: newMode
                });
                toolResult = { success: true, result: `Mode changed to ${newMode}` };
              } else {
                toolResult = { success: false, result: `Invalid mode: ${newMode}` };
              }
            } else {
              // Execute the tool
              toolResult = await this._toolExecutor.execute(toolCall.function.name, args);
            }

            // Notify UI about result
            this._view?.webview.postMessage({
              type: 'toolResult',
              tool: toolCall.function.name,
              success: toolResult.success,
              result: toolResult.result.slice(0, 500) + (toolResult.result.length > 500 ? '...' : '')
            });

            // Add tool result message
            this._messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: toolResult.result
            });
          }

          // Continue the loop to get next response - DON'T clear UI state yet
          // The next iteration will continue streaming
          continue;
        } else {
          // No tool calls, conversation turn is complete
          this._messages.push({ role: 'assistant', content: result.content });
          this._view?.webview.postMessage({ type: 'endAssistantMessage' });
          break;
        }
      } catch (error: any) {
        const rawMessage = error.message || 'An error occurred';
        // Map HTTP error codes to friendly messages, but prefer API error message if available
        let errorMessage = rawMessage;
        if (rawMessage.includes('HTTP 402')) {
          // Check if API provided a specific reason
          if (rawMessage.toLowerCase().includes('credit') || rawMessage.toLowerCase().includes('balance') || rawMessage.toLowerCase().includes('payment')) {
            errorMessage = 'Insufficient credits. Please add more credits at alia.onl to continue.';
          } else {
            errorMessage = 'Payment required. Please check your account at alia.onl.';
          }
        } else if (rawMessage.includes('HTTP 401')) {
          errorMessage = 'Invalid API key. Please check your settings.';
        } else if (rawMessage.includes('HTTP 429')) {
          errorMessage = 'Rate limit exceeded. Please wait a moment and try again.';
        } else if (rawMessage.includes('HTTP 500')) {
          errorMessage = 'Server error. Please try again later.';
        } else if (rawMessage.includes('HTTP 503')) {
          errorMessage = 'Service unavailable. Please try again later.';
        }
        this._view?.webview.postMessage({
          type: 'error',
          message: errorMessage
        });
        vscode.window.showErrorMessage(`Codea: ${errorMessage}`);
        break;
      }
    }

    this._isProcessing = false;
    // Auto-save conversation after exchange
    this.saveCurrentConversation();
  }

  private streamChatCompletion(
    baseUrl: string,
    apiKey: string,
    model: string,
    systemMessage: string,
    messages: Message[]
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/v1/codea/chat/completions`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      // Prepare messages with system message
      const allMessages = [
        { role: 'system', content: systemMessage },
        ...messages.map(m => {
          if (m.role === 'tool') {
            return {
              role: 'tool',
              tool_call_id: m.tool_call_id,
              content: m.content
            };
          } else if (m.tool_calls) {
            return {
              role: 'assistant',
              content: m.content || '',
              tool_calls: m.tool_calls
            };
          }
          return { role: m.role, content: m.content };
        })
      ];

      const requestBody = JSON.stringify({
        model,
        messages: allMessages,
        tools: fileTools,
        stream: true
      });

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(requestBody)
        }
      };

      let fullContent = '';
      const toolCalls: ToolCall[] = [];
      let currentToolCall: ToolCall | null = null;
      const controller = new AbortController();

      this._currentRequest = {
        abort: () => controller.abort()
      };

      const req = httpModule.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', chunk => errorBody += chunk);
          res.on('end', () => {
            try {
              const error = JSON.parse(errorBody);
              // Include status code and API message for better error handling
              const apiMessage = error.error?.message || error.message || '';
              reject(new Error(`HTTP ${res.statusCode}: ${apiMessage}`.trim()));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${errorBody}`));
            }
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          if (!this._isProcessing) return;

          buffer += chunk.toString();

          // Process complete SSE events
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();

              if (data === '[DONE]') {
                continue;
              }

              try {
                const parsed: ChatCompletionChunk = JSON.parse(data);
                const choice = parsed.choices?.[0];

                if (choice?.delta?.content) {
                  fullContent += choice.delta.content;
                  this._view?.webview.postMessage({
                    type: 'streamContent',
                    content: choice.delta.content
                  });
                }

                // Handle tool calls
                if (choice?.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    if (tc.id) {
                      // New tool call starting
                      currentToolCall = {
                        id: tc.id,
                        type: (tc.type as 'function') || 'function',
                        function: {
                          name: tc.function?.name || '',
                          arguments: tc.function?.arguments || ''
                        }
                      };
                      toolCalls.push(currentToolCall);
                      // Notify UI immediately that a tool call is starting
                      if (currentToolCall.function.name) {
                        this._view?.webview.postMessage({
                          type: 'toolCall',
                          tool: currentToolCall.function.name,
                          args: {},
                          status: 'preparing'
                        });
                      }
                    } else if (currentToolCall) {
                      // Append to current tool call
                      if (tc.function?.name) {
                        currentToolCall.function.name = tc.function.name;
                        // Notify UI when we know the tool name
                        this._view?.webview.postMessage({
                          type: 'toolCall',
                          tool: currentToolCall.function.name,
                          args: {},
                          status: 'preparing'
                        });
                      }
                      if (tc.function?.arguments) {
                        currentToolCall.function.arguments += tc.function.arguments;
                      }
                    }
                  }
                }
              } catch (e) {
                // Skip malformed JSON
              }
            }
          }
        });

        res.on('end', () => {
          this._currentRequest = undefined;
          resolve({ content: fullContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined });
        });
      });

      req.on('error', (error) => {
        this._currentRequest = undefined;
        reject(error);
      });

      controller.signal.addEventListener('abort', () => {
        req.destroy();
        resolve({ content: fullContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined });
      });

      req.write(requestBody);
      req.end();
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Get URIs for bundled webview assets
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.css'));
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'codea-logo.png'));

    // Use a nonce to only allow specific scripts to be run
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
