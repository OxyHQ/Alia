import * as vscode from 'vscode';
import { CodeaChatViewProvider } from './chatProvider';
import { AliaInlineCompletionProvider } from './inlineCompletionProvider';
import { AliaChatParticipant } from './chatParticipant';
import { AliaAuthenticationProvider } from './authProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('Codea by Alia is now active');

  // ============================================
  // 0. AUTHENTICATION PROVIDER
  // ============================================
  // Register Alia authentication provider for Codea Studio Code integration
  const authProvider = new AliaAuthenticationProvider(context);
  context.subscriptions.push(authProvider);
  console.log('✓ Authentication provider registered');

  // ============================================
  // 1. INLINE COMPLETIONS (Copilot-style)
  // ============================================
  const inlineProvider = new AliaInlineCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' }, // All files
      inlineProvider
    )
  );
  console.log('✓ Inline completion provider registered');

  // ============================================
  // 2. NATIVE CHAT PARTICIPANT
  // ============================================
  new AliaChatParticipant(context);
  console.log('✓ Chat participant registered');

  // Check if VS Code supports secondary sidebar (>= 1.66)
  const vscodeVersion = vscode.version.split('.');
  const majorVersion = parseInt(vscodeVersion[0], 10);
  const minorVersion = parseInt(vscodeVersion[1], 10);
  const supportsSecondarySidebar = majorVersion > 1 || (majorVersion === 1 && minorVersion >= 66);

  // Set context for conditional view rendering
  vscode.commands.executeCommand(
    'setContext',
    'codea:doesNotSupportSecondarySidebar',
    !supportsSecondarySidebar
  );

  // ============================================
  // 3. CUSTOM WEBVIEW (with shadcn/ui)
  // ============================================
  const chatProvider = new CodeaChatViewProvider(context.extensionUri, context);

  // Register webview provider for primary sidebar (fallback for old VS Code)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codea.chatView', chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  // Register webview provider for secondary sidebar (right side)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codea.chatViewSecondary', chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codea.openChat', () => {
      // Try to focus secondary sidebar first, fallback to primary
      if (supportsSecondarySidebar) {
        vscode.commands.executeCommand('codea.chatViewSecondary.focus');
      } else {
        vscode.commands.executeCommand('codea.chatView.focus');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codea.newConversation', () => {
      chatProvider.newConversation();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codea.clearConversation', () => {
      chatProvider.clearConversation();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codea.openWalkthrough', () => {
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'oxy.alia-codea#codea-walkthrough',
        false
      );
    })
  );

  // ============================================
  // 4. INTEGRATION COMMANDS
  // ============================================
  context.subscriptions.push(
    vscode.commands.registerCommand('codea.signIn', () => {
      vscode.window.showInputBox({
        prompt: 'Enter your Alia API key (starts with alia_sk_)',
        password: true,
        placeHolder: 'alia_sk_...'
      }).then(apiKey => {
        if (apiKey) {
          vscode.workspace.getConfiguration('codea').update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('Alia API key saved successfully!');
        }
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codea.refreshToken', () => {
      vscode.commands.executeCommand('codea.signIn');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codea.toggleStatusMenu', () => {
      vscode.commands.executeCommand('codea.openChat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codea.git.generateCommitMessage', async () => {
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      if (!gitExtension) {
        vscode.window.showErrorMessage('Git extension not available');
        return;
      }

      const api = gitExtension.getAPI(1);
      const repo = api.repositories[0];

      if (!repo) {
        vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const diff = await repo.diff(true);
      if (!diff) {
        vscode.window.showWarningMessage('No staged changes to generate commit message for');
        return;
      }

      // Open chat with the diff for commit message generation
      vscode.commands.executeCommand('codea.openChat');
      vscode.window.showInformationMessage('Generate a commit message for your staged changes in the chat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codea.git.resolveMergeConflicts', () => {
      vscode.commands.executeCommand('codea.openChat');
      vscode.window.showInformationMessage('Ask Codea to help resolve merge conflicts in the chat');
    })
  );
}

export function deactivate() {
  console.log('Codea by Alia deactivated');
}
