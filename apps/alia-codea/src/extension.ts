import * as vscode from 'vscode';
import { CodeaChatViewProvider } from './chatProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('Codea by Alia is now active');

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

  // Create chat view provider
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
}

export function deactivate() {
  console.log('Codea by Alia deactivated');
}
