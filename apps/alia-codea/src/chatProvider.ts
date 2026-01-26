import * as vscode from 'vscode';
import { fileTools, ToolExecutor, createAISDKTools } from './tools';
import { streamText } from 'ai';
import { resolveModel, reportUsage } from './model-resolver';

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

  private async fetchModels(baseUrl: string): Promise<any[]> {
    const url = `${baseUrl}/v1/models?category=coding`;
    console.log('[Codea] Fetching models from URL:', url);

    try {
      const response = await fetch(url);
      console.log('[Codea] Models response status:', response.status);

      if (!response.ok) {
        return [];
      }

      const parsed = await response.json() as { data?: any[] };
      console.log('[Codea] Models response parsed, count:', parsed.data?.length);
      return parsed.data || [];
    } catch (e) {
      console.error('[Codea] Models request error:', e);
      return [];
    }
  }

  private async fetchUserInfo(baseUrl: string, apiKey: string): Promise<{ id?: string; name?: { first?: string; last?: string; full?: string }; username?: string; email?: string; avatar?: string } | null> {
    const url = `${baseUrl}/v1/codea/me`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!response.ok) {
        return null;
      }

      return await response.json() as { id?: string; name?: { first?: string; last?: string; full?: string }; username?: string; email?: string; avatar?: string };
    } catch {
      return null;
    }
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

    // Check if we're in a browser environment (no child_process available)
    if (typeof process === 'undefined' || !process.versions?.node) {
      return 'Git diff is not available in web environment.';
    }

    return new Promise((resolve) => {
      // Dynamic require to avoid bundling issues in browser
      const cp = require('child_process');
      cp.exec('git diff HEAD', { cwd: workspaceFolder.uri.fsPath, maxBuffer: 1024 * 1024 }, (error: Error | null, stdout: string) => {
        if (error) {
          // Try just unstaged changes
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
    // Start assistant response
    this._view?.webview.postMessage({ type: 'startAssistantMessage' });

    try {
      // AI SDK handles tool execution loop internally with maxSteps
      const result = await this.streamChatCompletion(baseUrl, apiKey, model, systemMessage, this._messages);

      if (!this._isProcessing) return;

      // Add intermediate messages (tool calls and results) to conversation
      if (result.newMessages && result.newMessages.length > 0) {
        this._messages.push(...result.newMessages);
      }

      // Add final assistant message to conversation
      if (result.content) {
        this._messages.push({ role: 'assistant', content: result.content });
      }

      // End assistant message
      this._view?.webview.postMessage({ type: 'endAssistantMessage' });
    } catch (error: any) {
      const rawMessage = error.message || 'An error occurred';
      // Map HTTP error codes to friendly messages, but prefer API error message if available
      let errorMessage = rawMessage;
      if (rawMessage.includes('HTTP 402') || rawMessage.includes('402')) {
        // Check if API provided a specific reason
        if (rawMessage.toLowerCase().includes('credit') || rawMessage.toLowerCase().includes('balance') || rawMessage.toLowerCase().includes('payment')) {
          errorMessage = 'Insufficient credits. Please add more credits at alia.onl to continue.';
        } else {
          errorMessage = 'Payment required. Please check your account at alia.onl.';
        }
      } else if (rawMessage.includes('HTTP 401') || rawMessage.includes('401')) {
        errorMessage = 'Invalid API key. Please check your settings.';
      } else if (rawMessage.includes('HTTP 429') || rawMessage.includes('429')) {
        errorMessage = 'Rate limit exceeded. Please wait a moment and try again.';
      } else if (rawMessage.includes('HTTP 500') || rawMessage.includes('500')) {
        errorMessage = 'Server error. Please try again later.';
      } else if (rawMessage.includes('HTTP 503') || rawMessage.includes('503')) {
        errorMessage = 'Service unavailable. Please try again later.';
      }
      this._view?.webview.postMessage({
        type: 'error',
        message: errorMessage
      });
      vscode.window.showErrorMessage(`Codea: ${errorMessage}`);
    } finally {
      this._isProcessing = false;
      // Auto-save conversation after exchange
      this.saveCurrentConversation();
    }
  }

  private async streamChatCompletion(
    baseUrl: string,
    apiKey: string,
    model: string,
    systemMessage: string,
    messages: Message[]
  ): Promise<{ content: string; toolCalls?: ToolCall[]; newMessages?: Message[] }> {
    // Resolve model using centralized API
    console.log('[Codea] Resolving model:', model);
    const resolved = await resolveModel(baseUrl, apiKey, model);
    console.log('[Codea] Resolved to:', resolved.provider, resolved.modelId);

    // Convert messages to AI SDK format (exclude system message as it's passed separately)
    const modelMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        if (m.role === 'tool') {
          return {
            role: 'tool' as const,
            content: [{ type: 'tool-result' as const, toolCallId: m.tool_call_id || '', toolName: m.name || '', result: m.content }]
          };
        } else if (m.tool_calls) {
          return {
            role: 'assistant' as const,
            content: [
              ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
              ...m.tool_calls.map(tc => ({
                type: 'tool-call' as const,
                toolCallId: tc.id,
                toolName: tc.function.name,
                args: JSON.parse(tc.function.arguments)
              }))
            ]
          };
        }
        return {
          role: m.role as 'user' | 'assistant',
          content: m.content
        };
      });

    // Create AI SDK tools with UI update wrappers
    const toolExecutor = this._toolExecutor;
    const view = this._view;
    const currentModeRef = { mode: this._currentMode };

    const aiTools = createAISDKTools({
      execute: async (toolName: string, args: any) => {
        // Handle set_mode specially
        if (toolName === 'set_mode') {
          const newMode = args.mode;
          if (['ask', 'edit', 'plan', 'yolo'].includes(newMode)) {
            currentModeRef.mode = newMode;
            this._currentMode = newMode;
            view?.webview.postMessage({
              type: 'modeChanged',
              mode: newMode
            });
            return { success: true, result: `Mode changed to ${newMode}` };
          } else {
            return { success: false, result: `Invalid mode: ${newMode}` };
          }
        }

        // Notify UI about tool execution
        view?.webview.postMessage({
          type: 'toolCall',
          tool: toolName,
          args: args,
          status: 'running'
        });

        // Execute the tool
        const result = await toolExecutor.execute(toolName, args);

        // Notify UI about result
        view?.webview.postMessage({
          type: 'toolResult',
          tool: toolName,
          success: result.success,
          result: result.result.slice(0, 500) + (result.result.length > 500 ? '...' : '')
        });

        return result;
      }
    });

    const controller = new AbortController();
    this._currentRequest = {
      abort: () => controller.abort()
    };

    let fullContent = '';
    const toolCalls: ToolCall[] = [];
    const newMessages: Message[] = [];
    let currentStepToolCalls: ToolCall[] = [];
    let currentStepContent = '';

    try {
      const result = streamText({
        model: resolved.model,
        system: systemMessage,
        messages: modelMessages,
        tools: aiTools,
        maxSteps: 10,

        // Enhanced call options
        maxRetries: 3,
        temperature: 0.7,
        maxTokens: 4096,

        // Prompt caching for Anthropic
        experimental_providerMetadata: resolved.provider === 'anthropic' ? {
          anthropic: { cacheControl: [{ type: 'ephemeral' as const }] }
        } : undefined,

        // Error handling
        onError: (error) => {
          console.error('[Codea] AI SDK error:', error);
        },

        onFinish: async (event) => {
          console.log('[Codea] Finish reason:', event.finishReason);
          console.log('[Codea] Usage:', event.usage);

          // Report usage back to API
          if (event.usage && event.usage.totalTokens) {
            await reportUsage(
              baseUrl,
              apiKey,
              resolved.sessionId,
              {
                promptTokens: event.usage.promptTokens || 0,
                completionTokens: event.usage.completionTokens || 0,
                totalTokens: event.usage.totalTokens
              }
            ).catch(error => {
              console.error('[Codea] Failed to report usage:', error);
            });
          }
        },

        abortSignal: controller.signal
      });

      // Process streaming chunks
      for await (const chunk of result.fullStream) {
        if (!this._isProcessing) {
          break;
        }

        if (chunk.type === 'text-delta' && chunk.textDelta) {
          // Filter out thinking tags
          const filtered = chunk.textDelta.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
          if (filtered.trim()) {
            fullContent += filtered;
            currentStepContent += filtered;
            this._view?.webview.postMessage({
              type: 'streamContent',
              content: filtered
            });
          }
        } else if (chunk.type === 'tool-call') {
          // Track tool calls for this step
          const toolCall: ToolCall = {
            id: chunk.toolCallId,
            type: 'function',
            function: {
              name: chunk.toolName,
              arguments: JSON.stringify(chunk.args)
            }
          };
          toolCalls.push(toolCall);
          currentStepToolCalls.push(toolCall);
        } else if (chunk.type === 'tool-result') {
          // Add tool result message
          newMessages.push({
            role: 'tool',
            tool_call_id: chunk.toolCallId,
            name: chunk.toolName,
            content: typeof chunk.result === 'string' ? chunk.result : JSON.stringify(chunk.result)
          });
        } else if (chunk.type === 'step-finish') {
          // Step finished - add assistant message with tool calls if any
          if (currentStepToolCalls.length > 0) {
            newMessages.push({
              role: 'assistant',
              content: currentStepContent,
              tool_calls: currentStepToolCalls
            });
            currentStepToolCalls = [];
            currentStepContent = '';
          }
        } else if (chunk.type === 'finish') {
          // Stream finished
          break;
        }
      }

      this._currentRequest = undefined;
      return {
        content: fullContent.trim(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        newMessages: newMessages.length > 0 ? newMessages : undefined
      };
    } catch (error) {
      this._currentRequest = undefined;
      if (error instanceof Error && error.name === 'AbortError') {
        return { content: fullContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
      }
      throw error;
    }
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
