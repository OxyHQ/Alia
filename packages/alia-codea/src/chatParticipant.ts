import * as vscode from 'vscode';
import type OpenAI from 'openai';
import { AliaServerClient, createAliaTurnControl } from '@alia.onl/server';
import type { AliaAuthenticationProvider } from './authProvider';
import { log } from './logger';
import { resolveModelId } from './catalogue';
import { AliaChatError, streamAliaChat } from './aliaChat';

export class AliaChatParticipant {
  private apiBaseUrl: string = '';
  private model: string = '';
  private participant: vscode.ChatParticipant | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private readonly authProvider: AliaAuthenticationProvider,
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
    // Empty means the server's default model.
    this.model = config.get<string>('model', '');
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
          token: vscode.CancellationToken,
        ) => {
          return this.handleChatRequest(request, context, stream, token);
        },
      );

      // Set participant metadata
      this.participant.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        'resources',
        'codea-logo.png',
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
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult | void> {
    let contextChanged = false;
    const stopContext = this.authProvider.onSessionContextChange(() => {
      contextChanged = true;
    });
    try {
      const accessToken = await this.authProvider.getAccessToken();
      if (contextChanged || token.isCancellationRequested) return;
      const accountId = this.authProvider.getOxyServices().session.userId;
      if (!accessToken || !accountId) {
        stream.markdown(
          '**Sign-in Required**\n\nPlease sign in using the `Codea: Sign In` command (Ctrl+Shift+P).',
        );
        return { metadata: { error: 'Not authenticated' } };
      }
      stream.progress('Thinking...');
      const messages = this.buildMessages(request, context, accountId);
      await this.streamResponse(messages, stream, token);
      if (contextChanged || token.isCancellationRequested) return;
      return { metadata: { success: true, oxyAccountId: accountId } };
    } catch (error) {
      if (contextChanged || token.isCancellationRequested) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      stream.markdown(`**Error**: ${errorMessage}`);
      return { metadata: { error: errorMessage } };
    } finally {
      stopContext();
    }
  }

  private buildMessages(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    accountId: string,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are Codea, an expert coding assistant powered by Alia. You help developers write, understand, and improve their code. Provide clear, concise, and helpful responses. Format code using markdown code blocks.',
      },
    ];

    // Native VS Code chat history survives Oxy account changes. Reuse only a
    // request/response pair that this participant completed for this account.
    for (let index = 0; index < context.history.length - 1; index++) {
      const requestTurn = context.history[index];
      const responseTurn = context.history[index + 1];
      if (
        !(requestTurn instanceof vscode.ChatRequestTurn) ||
        !(responseTurn instanceof vscode.ChatResponseTurn) ||
        responseTurn.result.metadata?.oxyAccountId !== accountId
      )
        continue;
      messages.push({ role: 'user', content: requestTurn.prompt });
      const responseText = responseTurn.response
        .map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ''))
        .join('\n');
      if (responseText) messages.push({ role: 'assistant', content: responseText });
      index++;
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
      content: userMessage,
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
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('codea');
    const maxTokens = config.get('maxTokens', 4096);
    const temperature = config.get('temperature', 0.7);

    // The native chat panel's Stop is explicit remote cancellation. Context
    // changes only detach; no request may migrate to a replacement account.
    const controller = new AbortController();
    const lifetime = new AbortController();
    if (token.isCancellationRequested) controller.abort();
    const linked = this.authProvider.createLinkedClient(this.apiBaseUrl);
    const control = createAliaTurnControl(
      new AliaServerClient({ baseUrl: this.apiBaseUrl, fetch: linked.fetch }),
      { controller, lifetimeSignal: lifetime.signal },
    );
    const cancellation = token.onCancellationRequested(() => {
      void control.stop().catch(() => {
        if (!controller.signal.aborted) {
          void vscode.window.showErrorMessage(
            'Generation could not be stopped. It may continue in the background.',
          );
        }
      });
    });
    const stopContext = this.authProvider.onSessionContextChange(() => {
      lifetime.abort();
      controller.abort();
    });
    const attempt = (model: string | undefined) =>
      streamAliaChat({
        baseUrl: this.apiBaseUrl,
        fetch: linked.fetch,
        body: { model, messages, max_tokens: maxTokens, temperature, turnId: control.id },
        signal: controller.signal,
      });

    /**
     * Render one stream. Returns whether it ended in the server's stand-in,
     * which is reported as an error rather than shown: the busy sentence is
     * not Codea's answer, and a `ChatResult` that says success over it would
     * be remembered by VS Code as one.
     */
    const render = async (model: string | undefined): Promise<{ retryable: boolean } | null> => {
      let synthetic: { retryable: boolean } | null = null;
      for await (const event of attempt(model)) {
        if (controller.signal.aborted) break;
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
      const model = await resolveModelId(this.apiBaseUrl, this.model, linked.fetch);
      if (controller.signal.aborted) return;
      const synthetic = await render(model);

      if (synthetic !== null) {
        throw new AliaChatError(
          synthetic.retryable
            ? 'Alia could not finish that answer. Please send your message again.'
            : 'Alia could not answer that request.',
          { retryable: synthetic.retryable },
        );
      }
    } catch (error: unknown) {
      // A cancelled turn is not an error to report: the abort above rejects
      // the fetch with `AbortError`, and the person already stopped it.
      if (token.isCancellationRequested || (error instanceof Error && error.name === 'AbortError'))
        return;
      throw error;
    } finally {
      // The listener is on VS Code's token, which outlives this request.
      await control.finish();
      lifetime.abort();
      cancellation.dispose();
      stopContext();
      linked.dispose();
    }
  }
}
