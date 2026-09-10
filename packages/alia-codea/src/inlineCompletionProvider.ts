import * as vscode from 'vscode';
import type { AliaAuthenticationProvider } from './authProvider';
import { log } from './logger';
import { PREFERRED_MODEL_ID } from './config';
import { resolveModelId } from './catalogue';
import { isSyntheticCompletion } from './aliaChat';

export class AliaInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private apiBaseUrl: string = '';
  private model: string = '';

  constructor(private readonly authProvider: AliaAuthenticationProvider) {
    this.loadConfig();

    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codea')) {
        this.loadConfig();
      }
    });
  }

  private loadConfig() {
    const config = vscode.workspace.getConfiguration('codea');
    this.apiBaseUrl = config.get('apiBaseUrl', 'https://api.alia.onl');
    this.model = config.get('model', PREFERRED_MODEL_ID);
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null | undefined> {

    // Check if inline completions are enabled
    const config = vscode.workspace.getConfiguration('codea');
    const enabled = config.get('enableInlineCompletions', true);
    if (!enabled) {
      return null;
    }

    // Don't provide completions if not authenticated
    const accessToken = await this.authProvider.getAccessToken();
    if (!accessToken) {
      return null;
    }

    // Don't trigger on every keystroke - only when explicitly invoked or after a pause
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      // You might want to add a debounce here
      // For now, we'll just return null on automatic triggers
      // return null;
    }

    try {
      const completion = await this.getCompletion(document, position, token, accessToken);

      if (!completion || token.isCancellationRequested) {
        return null;
      }

      return [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position)
        )
      ];
    } catch (error) {
      log.error('Alia inline completion error:', error);
      return null;
    }
  }

  private async getCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    accessToken: string
  ): Promise<string | null> {
    // Get context around the cursor
    const prefix = document.getText(new vscode.Range(
      new vscode.Position(Math.max(0, position.line - 10), 0),
      position
    ));

    /**
     * The ten lines AFTER the cursor.
     *
     * The end position used to be `Math.min(document.lineCount - 1, position.line + 10)`
     * at column 0 — which, within ten lines of the end of the file, clamps to a
     * line at or BEFORE the cursor. `vscode.Range` silently swaps endpoints
     * that are out of order, so `getText` returned the text before the cursor
     * and handed it to the model under the header `CODE AFTER CURSOR`. Editing
     * near the end of a file is the common case, and the completions were
     * quietly worse there.
     *
     * `document.lineAt(...).range.end` rather than column 0 of the next line,
     * so the last line of the file is included whole.
     */
    const lastLine = Math.min(document.lineCount - 1, position.line + 10);
    const suffixEnd = document.lineAt(lastLine).range.end;
    const suffix = suffixEnd.isAfter(position)
      ? document.getText(new vscode.Range(position, suffixEnd))
      : '';

    // Build the prompt
    const prompt = this.buildPrompt(document, prefix, suffix);

    /**
     * Cancellation that actually cancels.
     *
     * This was `signal: token.isCancellationRequested ? AbortSignal.abort() : undefined`,
     * which evaluates ONCE, while the request is being built. In the normal
     * case the token is not cancelled yet, so the signal was `undefined` and
     * the request was never abortable at all — VS Code cancelled, and a
     * 500-token completion ran to completion and was billed anyway. With the
     * automatic-trigger guard commented out below, that is one per keystroke.
     */
    const controller = new AbortController();
    if (token.isCancellationRequested) controller.abort();
    const cancellation = token.onCancellationRequested(() => { controller.abort(); });

    try {
      // The product runtime — same reason as `chatParticipant.ts`.
      const response = await fetch(`${this.apiBaseUrl}/alia/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          // Resolved at the request: this is the moment an identifier is about
          // to be sent, and an unreadable catalogue leaves it alone.
          model: await resolveModelId(this.apiBaseUrl, this.model, accessToken),
          messages: [
            {
              role: 'system',
              content: 'You are an expert code completion assistant. Provide only the code completion, nothing else. Do not include explanations, markdown, or code fences. Just the raw completion code.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 500,
          temperature: 0.2,
          stream: false
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      /**
       * The server never answers this path with a raw failure. When every
       * provider is busy, or the 80s budget runs out, it returns a friendly
       * sentence flagged `alia_meta.synthetic` (`routes/v1/chat-completions.ts`),
       * and `choices[0].message.content` is then "I'm sorry, all models are
       * currently busy…" — which this used to hand to VS Code as ghost text to
       * insert into the file. No completion is the honest answer.
       */
      if (isSyntheticCompletion(data)) {
        log.warn('Alia inline completion: server sent a synthetic stand-in, offering nothing');
        return null;
      }

      const completion = data.choices?.[0]?.message?.content?.trim();

      if (!completion) {
        return null;
      }

      // Clean up the completion (remove markdown code fences if any)
      return this.cleanCompletion(completion);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return null;
      }
      throw error;
    } finally {
      // The listener is on VS Code's token, which outlives this request.
      cancellation.dispose();
    }
  }

  private buildPrompt(
    document: vscode.TextDocument,
    prefix: string,
    suffix: string
  ): string {
    const language = document.languageId;

    return `Complete the following ${language} code. Provide only the completion for the cursor position, do not repeat the prefix.

File: ${document.fileName}
Language: ${language}

--- CODE BEFORE CURSOR ---
${prefix}
--- CURSOR POSITION ---
--- CODE AFTER CURSOR ---
${suffix}

Provide ONLY the code that should appear at the cursor position. No explanations, no markdown.`;
  }

  private cleanCompletion(completion: string): string {
    // Remove markdown code fences if present
    let cleaned = completion.replace(/```[\w]*\n?/g, '').replace(/```$/g, '');

    // Remove any leading/trailing whitespace
    cleaned = cleaned.trim();

    return cleaned;
  }
}
