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
      this._userName = userInfo?.name || null;
      this._view?.webview.postMessage({ type: 'userInfo', userName: this._userName });
    } catch (error) {
      this._view?.webview.postMessage({ type: 'userInfo', userName: null });
    }
  }

  private fetchUserInfo(baseUrl: string, apiKey: string): Promise<{ name?: string } | null> {
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

    // Fetch and send user info to webview
    this.fetchAndSendUserInfo();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          await this.handleUserMessage(data.message, data.mode, data.model);
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
  }

  private async handleUserMessage(content: string, mode: string = 'ask', selectedModel?: string) {
    if (this._isProcessing) return;

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
      openTabs: context.openTabs
    });

    // Build system message based on mode
    const systemMessage = this.buildSystemMessage(mode, context);

    // Enhance user message with context if they're referencing code
    let enhancedContent = content;
    const referencesCode = /\b(this|the|explain|review|fix|debug|code|file|function|error|codebase|project)\b/i.test(content);

    // Debug log
    console.log('[Codea] Message analysis:', {
      content: content.substring(0, 50),
      referencesCode,
      hasSelection: !!context.selection,
      hasOpenFile: !!context.openFile,
      messageCount: this._messages.length
    });

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
    let systemMessage = `You are Codea, an AI coding assistant created by Alia. You help users write, debug, and understand code.

IMPORTANT: When the user provides code in their message (in a code block), answer using that code directly. Do NOT ask them to share code that they have already provided.

You have access to tools that allow you to:
- read_file: Read files from the workspace
- write_file: Create or overwrite files
- edit_file: Make precise text replacements in files
- delete_file: Remove files
- list_files: List directory contents
- search_files: Search for text across files
- run_command: Execute shell commands

When making changes:
- Use edit_file for small precise changes
- Use write_file to create new files or rewrite entire files

Be concise and helpful.`;

    if (mode === 'edit') {
      systemMessage += `\n\nMode: EDIT - Focus on making code changes. Prefer using tools to directly modify files rather than just showing code snippets.`;
    } else if (mode === 'plan') {
      systemMessage += `\n\nMode: PLAN - Create a detailed plan before making changes. List all files that need to be modified and the changes needed. Ask for confirmation before proceeding.`;
    } else if (mode === 'yolo') {
      systemMessage += `\n\nMode: YOLO - Make changes directly without asking for confirmation. Be efficient and complete the task quickly.`;
    }

    // Add list of open tabs as context (but not full file contents - those go in user message)
    if (context.openTabs?.length > 0) {
      systemMessage += `\n\n## Currently Open Files in Editor\n${context.openTabs.join('\n')}`;
    }

    return systemMessage;
  }

  private async processConversation(baseUrl: string, apiKey: string, model: string, systemMessage: string): Promise<void> {
    while (this._isProcessing) {
      // Start assistant response
      this._view?.webview.postMessage({ type: 'startAssistantMessage' });

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

            // Execute the tool
            const toolResult = await this._toolExecutor.execute(toolCall.function.name, args);

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

          // Continue the loop to get next response
          this._view?.webview.postMessage({ type: 'endAssistantMessage' });
          continue;
        } else {
          // No tool calls, conversation turn is complete
          this._messages.push({ role: 'assistant', content: result.content });
          this._view?.webview.postMessage({ type: 'endAssistantMessage' });
          break;
        }
      } catch (error: any) {
        const errorMessage = error.message || 'An error occurred';
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
              reject(new Error(error.error?.message || `HTTP ${res.statusCode}`));
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
                      // New tool call
                      currentToolCall = {
                        id: tc.id,
                        type: (tc.type as 'function') || 'function',
                        function: {
                          name: tc.function?.name || '',
                          arguments: tc.function?.arguments || ''
                        }
                      };
                      toolCalls.push(currentToolCall);
                    } else if (currentToolCall && tc.function?.arguments) {
                      // Append to current tool call arguments
                      currentToolCall.function.arguments += tc.function.arguments;
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
  <style>
    /* Expose logo URI to React app */
    :root {
      --codea-logo-uri: url('${logoUri}');
    }
  </style>
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
