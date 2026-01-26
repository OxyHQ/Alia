import * as vscode from 'vscode';
import OpenAI from 'openai';
import { fileTools, ToolExecutor } from './tools';

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
      this._userName = userInfo?.name?.first || userInfo?.username || userInfo?.email?.split('@')[0] || null;
      this._view?.webview.postMessage({ type: 'userInfo', userName: this._userName });
    } catch (error) {
      this._view?.webview.postMessage({ type: 'userInfo', userName: null });
    }
  }

  private async fetchAndSendModels(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codea');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.alia.onl';

    try {
      const models = await this.fetchModels(baseUrl);
      this._view?.webview.postMessage({ type: 'models', models });
    } catch (error) {
      this._view?.webview.postMessage({ type: 'models', models: [] });
    }
  }

  private async fetchModels(baseUrl: string): Promise<any[]> {
    const url = `${baseUrl}/v1/models?category=coding`;

    try {
      const response = await fetch(url);
      if (!response.ok) return [];
      const parsed = await response.json() as { data?: any[] };
      return parsed.data || [];
    } catch (e) {
      return [];
    }
  }

  private async fetchUserInfo(baseUrl: string, apiKey: string): Promise<any> {
    const url = `${baseUrl}/v1/codea/me`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!response.ok) return null;
      return await response.json();
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

    this.fetchAndSendUserInfo();
    this.fetchAndSendModels();

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
    await this.processConversation(baseUrl, apiKey, model, clientContext);
  }

  private buildClientContext(mode: string, context: any): string {
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

    if (context.openTabs?.length > 0) {
      clientContext += `\n\n=== CURRENTLY OPEN FILES ===\n${context.openTabs.map((f: string) => `- ${f}`).join('\n')}`;
    }

    if (context.openFile) {
      clientContext += `\n\n=== ACTIVE EDITOR ===\nFile: ${context.openFile.path}\nLanguage: ${context.openFile.language || 'unknown'}`;
    }

    return clientContext;
  }

  private async processConversation(baseUrl: string, apiKey: string, model: string, clientContext: string): Promise<void> {
    this._view?.webview.postMessage({ type: 'startAssistantMessage' });

    try {
      const openai = new OpenAI({
        apiKey,
        baseURL: `${baseUrl}/v1`
      });

      this._abortController = new AbortController();

      // Add client context as system message for first message
      // The backend will prepend its own model-specific prompt
      const messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = this._messages.length === 1
        ? [{ role: 'system', content: clientContext }, ...this._messages]
        : this._messages; // Don't add system message on continuation

      await this.streamChatCompletion(openai, model, messages);

      this._view?.webview.postMessage({ type: 'endAssistantMessage' });
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        const errorMessage = this.formatErrorMessage(error);
        this._view?.webview.postMessage({
          type: 'error',
          message: errorMessage
        });
        vscode.window.showErrorMessage(`Codea: ${errorMessage}`);
      }
    } finally {
      this._isProcessing = false;
      this.saveCurrentConversation();
    }
  }

  private async streamChatCompletion(
    openai: OpenAI,
    model: string,
    messages: Array<OpenAI.Chat.ChatCompletionMessageParam>
  ): Promise<void> {
    const stream = await openai.chat.completions.create(
      {
        model,
        messages,
        tools: fileTools as OpenAI.Chat.ChatCompletionTool[],
        stream: true,
        temperature: 0.7,
        max_tokens: 4096
      },
      {
        signal: this._abortController?.signal
      }
    );

    let assistantMessage = '';
    let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

    for await (const chunk of stream) {
      if (!this._isProcessing) break;

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        assistantMessage += delta.content;
        this._view?.webview.postMessage({
          type: 'streamContent',
          content: delta.content
        });
      }

      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index ?? toolCalls.length;

          if (!toolCalls[index]) {
            toolCalls[index] = {
              id: toolCall.id || '',
              type: 'function',
              function: { name: toolCall.function?.name || '', arguments: '' }
            } as OpenAI.Chat.ChatCompletionMessageToolCall;
          }

          if (toolCall.function?.name) {
            (toolCalls[index] as any).function.name = toolCall.function.name;
          }

          if (toolCall.function?.arguments) {
            (toolCalls[index] as any).function.arguments += toolCall.function.arguments;
          }

          if (toolCall.id) {
            toolCalls[index].id = toolCall.id;
          }
        }
      }
    }

    const validToolCalls = toolCalls.filter(tc => tc && tc.id && (tc as any).function && (tc as any).function.name);

    if (assistantMessage || validToolCalls.length > 0) {
      const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: assistantMessage || null
      };
      if (validToolCalls.length > 0) {
        assistantMsg.tool_calls = validToolCalls;
      }
      this._messages.push(assistantMsg);
    }

    if (validToolCalls.length > 0) {
      for (const toolCall of validToolCalls) {
        const toolName = (toolCall as any).function.name;
        let args: any = {};
        try {
          args = JSON.parse((toolCall as any).function.arguments || '{}');
        } catch (e) {
          console.error('[Codea] Failed to parse tool arguments:', (toolCall as any).function.arguments, e);
          continue;
        }

        if (toolName === 'set_mode') {
          this._currentMode = args.mode;
          this._view?.webview.postMessage({
            type: 'modeChanged',
            mode: this._currentMode
          });
        }

        this._view?.webview.postMessage({
          type: 'toolCall',
          tool: toolName,
          args,
          status: 'running'
        });

        try {
          const result = await this._toolExecutor.execute(toolName, args);

          this._messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result.success ? result.result : `Error: ${result.result}`
          });

          this._view?.webview.postMessage({
            type: 'toolResult',
            tool: toolName,
            success: result.success,
            result: result.result.slice(0, 500) + (result.result.length > 500 ? '...' : '')
          });
        } catch (error: any) {
          const errorMsg = error.message || String(error);
          this._messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error: ${errorMsg}`
          });

          this._view?.webview.postMessage({
            type: 'toolResult',
            tool: toolName,
            success: false,
            result: errorMsg
          });
        }
      }

      // Continue with tool results
      await this.continueWithToolResults(openai, model, messages);
    }
  }

  private async continueWithToolResults(
    openai: OpenAI,
    model: string,
    baseMessages: Array<OpenAI.Chat.ChatCompletionMessageParam>,
    iterationCount: number = 0
  ): Promise<void> {
    const MAX_ITERATIONS = 10;
    if (iterationCount >= MAX_ITERATIONS) {
      console.warn(`[Codea] Max iterations (${MAX_ITERATIONS}) reached`);
      return;
    }

    const stream = await openai.chat.completions.create(
      {
        model,
        messages: this._messages,
        tools: fileTools as OpenAI.Chat.ChatCompletionTool[],
        stream: true,
        temperature: 0.7,
        max_tokens: 4096
      },
      {
        signal: this._abortController?.signal
      }
    );

    let assistantMessage = '';
    let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

    for await (const chunk of stream) {
      if (!this._isProcessing) break;

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        assistantMessage += delta.content;
        this._view?.webview.postMessage({
          type: 'streamContent',
          content: delta.content
        });
      }

      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index ?? toolCalls.length;
          if (!toolCalls[index]) {
            toolCalls[index] = {
              id: toolCall.id || '',
              type: 'function',
              function: { name: toolCall.function?.name || '', arguments: '' }
            } as OpenAI.Chat.ChatCompletionMessageToolCall;
          }

          if (toolCall.function?.name) {
            (toolCalls[index] as any).function.name = toolCall.function.name;
          }

          if (toolCall.function?.arguments) {
            (toolCalls[index] as any).function.arguments += toolCall.function.arguments;
          }

          if (toolCall.id) {
            toolCalls[index].id = toolCall.id;
          }
        }
      }
    }

    const validToolCalls = toolCalls.filter(tc => tc && tc.id && (tc as any).function && (tc as any).function.name);

    if (assistantMessage || validToolCalls.length > 0) {
      const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: assistantMessage || null
      };
      if (validToolCalls.length > 0) {
        assistantMsg.tool_calls = validToolCalls;
      }
      this._messages.push(assistantMsg);
    }

    if (validToolCalls.length > 0) {
      for (const toolCall of validToolCalls) {
        const toolName = (toolCall as any).function.name;
        let args: any = {};
        try {
          args = JSON.parse((toolCall as any).function.arguments || '{}');
        } catch (e) {
          continue;
        }

        if (toolName === 'set_mode') {
          this._currentMode = args.mode;
          this._view?.webview.postMessage({
            type: 'modeChanged',
            mode: this._currentMode
          });
        }

        this._view?.webview.postMessage({
          type: 'toolCall',
          tool: toolName,
          args,
          status: 'running'
        });

        try {
          const result = await this._toolExecutor.execute(toolName, args);

          this._messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result.success ? result.result : `Error: ${result.result}`
          });

          this._view?.webview.postMessage({
            type: 'toolResult',
            tool: toolName,
            success: result.success,
            result: result.result.slice(0, 500)
          });
        } catch (error: any) {
          const errorMsg = error.message || String(error);
          this._messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error: ${errorMsg}`
          });

          this._view?.webview.postMessage({
            type: 'toolResult',
            tool: toolName,
            success: false,
            result: errorMsg
          });
        }
      }

      await this.continueWithToolResults(openai, model, baseMessages, iterationCount + 1);
    }
  }

  private formatErrorMessage(error: Error): string {
    const message = error.message || 'An error occurred';

    if (message.includes('402') || message.toLowerCase().includes('insufficient credits')) {
      return 'Insufficient credits. Please add more credits at alia.onl';
    } else if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
      return 'Invalid API key. Please check your settings.';
    } else if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
      return 'Rate limit exceeded. Please wait a moment and try again.';
    } else if (message.includes('500')) {
      return 'Server error. Please try again later.';
    } else if (message.includes('503')) {
      return 'Service unavailable. Please try again later.';
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
