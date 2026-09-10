import * as vscode from 'vscode';
import type OpenAI from 'openai';
import type { AliaAuthenticationProvider } from './authProvider';
import { log } from './logger';
import { PREFERRED_MODEL_ID } from './config';
import { resolveModelId } from './catalogue';
import { AliaChatError, streamAliaChat } from './aliaChat';

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
    this.model = config.get('model', PREFERRED_MODEL_ID);
  }

  private registerParticipant(context: vscode.ExtensionContext) {
    // Check if chat participant is enabled
    const config = vscode.workspace.getConfiguration('codea');
    const enabled = config.get('enableChatParticipant', true);
    if (!enabled) {
      log.info('Chat participant disabled in settings');
      return;
    }

    // Check if the chat API is available (VS Code 1.90+)
    if (!vscode.chat) {
      log.warn('Chat API not available in this VS Code version');
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

      log.info('Codea chat participant registered successfully');
    } catch (error) {
      log.error('Failed to register chat participant:', error);
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
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
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

  /**
   * Stream one answer into the chat view.
   *
   * `POST /alia/chat` through `./aliaChat`, which is what reads the frames the
   * hand-rolled loop this replaces did not: an in-stream error envelope was
   * ignored and the turn reported success with no text, and the
   * `alia_meta.synthetic` stand-in was rendered as the answer. Both are thrown
   * here and land in `handleChatRequest`'s error path, where the person sees
   * them as an error rather than as Codea's opinion.
   */
  private async streamResponse(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    accessToken: string
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('codea');
    const maxTokens = config.get('maxTokens', 4096);
    const temperature = config.get('temperature', 0.7);

    /**
     * Cancellation that actually cancels.
     *
     * `signal: token.isCancellationRequested ? AbortSignal.abort() : undefined`
     * evaluates ONCE, when the request is built. In the normal case the token
     * is not cancelled yet, so the signal was `undefined` and the stream could
     * never be aborted: cancelling in the chat view stopped the UI and left the
     * turn running — and billed — to completion. Created outside `makeRequest`
     * so the 401 retry below shares it.
     */
    const controller = new AbortController();
    if (token.isCancellationRequested) controller.abort();
    const cancellation = token.onCancellationRequested(() => { controller.abort(); });

    const model = await resolveModelId(this.apiBaseUrl, this.model, accessToken);
    const attempt = (bearerToken: string) =>
      streamAliaChat({
        baseUrl: this.apiBaseUrl,
        accessToken: bearerToken,
        body: { model, messages, max_tokens: maxTokens, temperature },
        signal: controller.signal,
      });

    /**
     * Render one stream. Returns whether it ended in the server's stand-in,
     * which is reported as an error rather than shown: the busy sentence is
     * not Codea's answer, and a `ChatResult` that says success over it would
     * be remembered by VS Code as one.
     */
    const render = async (bearerToken: string): Promise<{ retryable: boolean } | null> => {
      let synthetic: { retryable: boolean } | null = null;
      for await (const event of attempt(bearerToken)) {
        if (token.isCancellationRequested) break;
        switch (event.type) {
          case 'content':
            stream.markdown(event.text);
            break;
          case 'reasoning':
            // A progress line, not the answer: the chat view shows it while
            // the model works and folds it away when text arrives.
            stream.progress(event.text);
            break;
          case 'synthetic':
            synthetic = { retryable: event.retryable };
            break;
          case 'tool_calls':
          case 'tool_result':
          case 'finish':
          case 'event':
            // The participant offers no tools, so the server runs its own and
            // the answer arrives as text.
            break;
        }
      }
      return synthetic;
    };

    try {
      let synthetic: { retryable: boolean } | null;
      try {
        synthetic = await render(accessToken);
      } catch (error: unknown) {
        // On 401, re-mint once and retry. `getAccessToken` refreshes a stale
        // token itself; this is for a token the server rejected regardless.
        if (!(error instanceof AliaChatError) || error.status !== 401) throw error;
        const refreshed = await this.authProvider.refreshToken();
        const newToken = refreshed ? await this.authProvider.getAccessToken() : null;
        if (!newToken || newToken === accessToken) throw error;
        synthetic = await render(newToken);
      }

      if (synthetic !== null) {
        throw new AliaChatError(
          synthetic.retryable
            ? 'Alia could not finish that answer. Please send your message again.'
            : 'Alia could not answer that request.',
          { retryable: synthetic.retryable }
        );
      }
    } catch (error: unknown) {
      // A cancelled turn is not an error to report: the abort above rejects
      // the fetch with `AbortError`, and the person already stopped it.
      if (token.isCancellationRequested || (error instanceof Error && error.name === 'AbortError')) return;
      throw error;
    } finally {
      // The listener is on VS Code's token, which outlives this request.
      cancellation.dispose();
    }
  }
}
