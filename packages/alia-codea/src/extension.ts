import * as vscode from 'vscode';
import { CodeaChatViewProvider } from './chatProvider';
import { AliaInlineCompletionProvider } from './inlineCompletionProvider';
import { AliaChatParticipant } from './chatParticipant';
import { AliaAuthenticationProvider } from './authProvider';
import { McpLocalClient } from './mcp-client';
import { errorMessage } from './errors';
import { log, disposeLogger } from './logger';

let mcpClient: McpLocalClient | null = null;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push({ dispose: disposeLogger });

  const authProvider = new AliaAuthenticationProvider(context);
  context.subscriptions.push(authProvider);

  // Inline completions
  const inlineProvider = new AliaInlineCompletionProvider(authProvider);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider),
  );

  // Native chat participant
  new AliaChatParticipant(context, authProvider);

  // Secondary sidebar support (VS Code >= 1.66)
  const [major, minor] = vscode.version.split('.').map(Number);
  const hasSecondarySidebar = major > 1 || (major === 1 && minor >= 66);
  vscode.commands.executeCommand('setContext', 'codea:doesNotSupportSecondarySidebar', !hasSecondarySidebar);

  // Webview chat provider
  const chatProvider = new CodeaChatViewProvider(context.extensionUri, context, authProvider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codea.chatView', chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('codea.chatViewSecondary', chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Start local MCP client (non-blocking)
  mcpClient = new McpLocalClient(authProvider);
  context.subscriptions.push(mcpClient);
  mcpClient.start().catch((err) => log.error('[MCP] Startup error:', err));

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codea.openChat', () => {
      vscode.commands.executeCommand(
        hasSecondarySidebar ? 'codea.chatViewSecondary.focus' : 'codea.chatView.focus',
      );
    }),

    vscode.commands.registerCommand('codea.newConversation', () => chatProvider.newConversation()),
    vscode.commands.registerCommand('codea.clearConversation', () => chatProvider.clearConversation()),
    vscode.commands.registerCommand('codea.toggleStatusMenu', () => {
      vscode.commands.executeCommand('codea.openChat');
    }),

    vscode.commands.registerCommand('codea.openWalkthrough', () => {
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'oxy.alia-codea#codea-walkthrough', false);
    }),

    vscode.commands.registerCommand('codea.signIn', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: '$(globe) Sign in with browser', description: 'Opens auth.oxy.so (Recommended)', value: 'browser' },
        { label: '$(key) Enter API key', description: 'Legacy', value: 'apikey' },
      ], { placeHolder: 'Choose sign-in method' });

      if (choice?.value === 'browser') {
        try {
          await authProvider.signInWithBrowser();
        } catch (error: unknown) {
          const message = errorMessage(error);
          if (!message.includes('timed out')) {
            vscode.window.showErrorMessage(`Sign-in failed: ${message}`);
          }
        }
      } else if (choice?.value === 'apikey') {
        const apiKey = await vscode.window.showInputBox({
          prompt: 'Enter your Alia API key (starts with alia_sk_)',
          password: true,
          placeHolder: 'alia_sk_...',
        });
        if (apiKey) {
          await vscode.workspace.getConfiguration('codea').update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('Alia API key saved.');
        }
      }
    }),

    vscode.commands.registerCommand('codea.refreshToken', async () => {
      const success = await authProvider.refreshToken();
      if (success) {
        vscode.window.showInformationMessage('Token refreshed successfully.');
      } else {
        const action = await vscode.window.showWarningMessage('Token refresh failed. Please sign in again.', 'Sign In');
        if (action === 'Sign In') { vscode.commands.executeCommand('codea.signIn'); }
      }
    }),

    vscode.commands.registerCommand('codea.git.generateCommitMessage', async () => {
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      if (!gitExtension) { vscode.window.showErrorMessage('Git extension not available'); return; }

      const repo = gitExtension.getAPI(1).repositories[0];
      if (!repo) { vscode.window.showErrorMessage('No Git repository found'); return; }

      const diff = await repo.diff(true);
      if (!diff) { vscode.window.showWarningMessage('No staged changes to generate commit message for'); return; }

      vscode.commands.executeCommand('codea.openChat');
      vscode.window.showInformationMessage('Generate a commit message for your staged changes in the chat');
    }),

    vscode.commands.registerCommand('codea.git.resolveMergeConflicts', () => {
      vscode.commands.executeCommand('codea.openChat');
      vscode.window.showInformationMessage('Ask Codea to help resolve merge conflicts in the chat');
    }),
  );
}

export function deactivate() {
  mcpClient?.dispose();
  mcpClient = null;
}
