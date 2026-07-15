import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Alia Codea', { log: true });
  }
  return channel;
}

/**
 * Diagnostic logger for the Codea extension, backed by a VS Code
 * {@link vscode.LogOutputChannel}. Output is visible in the "Alia Codea"
 * output channel and honours the editor's configured log level.
 */
export const log = {
  debug(message: string, ...args: unknown[]): void {
    getChannel().debug(message, ...args);
  },
  info(message: string, ...args: unknown[]): void {
    getChannel().info(message, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    getChannel().warn(message, ...args);
  },
  error(error: string | Error, ...args: unknown[]): void {
    getChannel().error(error, ...args);
  },
};

/** Disposes the underlying output channel. Registered during activation. */
export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
