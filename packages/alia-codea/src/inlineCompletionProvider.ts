import * as vscode from 'vscode';
import type { AliaAuthenticationProvider } from './authProvider';
import { log } from './logger';

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
    this.model = config.get('model', 'alia-v1-codea');
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

    const suffix = document.getText(new vscode.Range(
      position,
      new vscode.Position(Math.min(document.lineCount - 1, position.line + 10), 0)
    ));

    // Build the prompt
    const prompt = this.buildPrompt(document, prefix, suffix);

    try {
      const response = await fetch(`${this.apiBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          model: this.model,
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
        signal: token.isCancellationRequested ? AbortSignal.abort() : undefined
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
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
