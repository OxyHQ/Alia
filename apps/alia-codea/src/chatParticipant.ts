import * as vscode from 'vscode';
import type { AliaAuthenticationProvider } from './authProvider';

export class AliaChatParticipant {
  private apiBaseUrl: string = '';
  private model: string = '';
  private participant: vscode.ChatParticipant | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private readonly authProvider: AliaAuthenticationProvider
  ) {
    this.loadConfig();

    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codea')) {
        this.loadConfig();
      }
    });

    // Register the chat participant
    this.registerParticipant(context);
  }

  private loadConfig() {
    const config = vscode.workspace.getConfiguration('codea');
    this.apiBaseUrl = config.get('apiBaseUrl', 'https://api.alia.onl');
    this.model = config.get('model', 'alia-v1-codea');
  }

  private registerParticipant(context: vscode.ExtensionContext) {
    // Check if chat participant is enabled
    const config = vscode.workspace.getConfiguration('codea');
    const enabled = config.get('enableChatParticipant', true);
    if (!enabled) {
      console.log('Chat participant disabled in settings');
      return;
    }

    // Check if the chat API is available (VS Code 1.90+)
    if (!vscode.chat) {
      console.log('Chat API not available in this VS Code version');
      return;
    }

    try {
      this.participant = vscode.chat.createChatParticipant(
        'codea',
        async (
          request: vscode.ChatRequest,
          context: vscode.ChatContext,
          stream: vscode.ChatResponseStream,
          token: vscode.CancellationToken
        ) => {
          return this.handleChatRequest(request, context, stream, token);
        }
      );

      // Set participant metadata
      this.participant.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        'resources',
        'codea-logo.png'
      );

      context.subscriptions.push(this.participant);

      console.log('Codea chat participant registered successfully');
    } catch (error) {
      console.error('Failed to register chat participant:', error);
    }
  }

  private async handleChatRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult | void> {

    const accessToken = await this.authProvider.getAccessToken();
    if (!accessToken) {
      stream.markdown('**Sign-in Required**\n\nPlease sign in using the `Codea: Sign In` command (Ctrl+Shift+P).');
      return { metadata: { error: 'Not authenticated' } };
    }

    try {
      // Show thinking indicator
      stream.progress('Thinking...');

      // Get conversation history
      const messages = this.buildMessages(request, context);

      // Stream the response
      await this.streamResponse(messages, stream, token, accessToken);

      return { metadata: { success: true } };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      stream.markdown(`**Error**: ${errorMessage}`);
      return { metadata: { error: errorMessage } };
    }
  }

  private buildMessages(
    request: vscode.ChatRequest,
    context: vscode.ChatContext
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content: 'You are Codea, an expert coding assistant powered by Alia. You help developers write, understand, and improve their code. Provide clear, concise, and helpful responses. Format code using markdown code blocks.'
      }
    ];

    // Add conversation history
    for (const turn of context.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push({
          role: 'user',
          content: turn.prompt
        });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        // Get the response text
        const responseText = turn.response
          .map(part => {
            if (part instanceof vscode.ChatResponseMarkdownPart) {
              return part.value.value;
            }
            return '';
          })
          .join('\n');

        if (responseText) {
          messages.push({
            role: 'assistant',
            content: responseText
          });
        }
      }
    }

    // Add current request with references
    let userMessage = request.prompt;

    // Add file references if any
    if (request.references && request.references.length > 0) {
      userMessage += '\n\n**Referenced Files:**\n';
      for (const ref of request.references) {
        if (ref.value instanceof vscode.Uri) {
          userMessage += `- ${ref.value.fsPath}\n`;
        }
      }
    }

    messages.push({
      role: 'user',
      content: userMessage
    });

    return messages;
  }

  private async streamResponse(
    messages: Array<{ role: string; content: string }>,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    accessToken: string
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('codea');
    const maxTokens = config.get('maxTokens', 4096);
    const temperature = config.get('temperature', 0.7);

    const response = await fetch(`${this.apiBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true
      }),
      signal: token.isCancellationRequested ? AbortSignal.abort() : undefined
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (token.isCancellationRequested) {
        reader.cancel();
        break;
      }

      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          if (data === '[DONE]') {
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;

            if (content) {
              stream.markdown(content);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
  }
}
