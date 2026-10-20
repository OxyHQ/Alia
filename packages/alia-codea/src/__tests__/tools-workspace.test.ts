import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { ToolExecutor } from '../tools';
import { fireWorkspaceFolders } from './vscode.mock';

/**
 * The root the tools resolve against follows the window's workspace folders: a folder opened
 * after the extension started (or removed) changes it.
 */

const workspace = vscode.workspace as unknown as {
  workspaceFolders: { uri: { fsPath: string } }[] | undefined;
};

describe('ToolExecutor workspace root', () => {
  it('picks up a folder opened after construction', () => {
    workspace.workspaceFolders = undefined;
    const tools = new ToolExecutor();
    const resolve = (
      tools as unknown as { resolveUri(p: string): { fsPath: string } }
    ).resolveUri.bind(tools);
    expect(() => resolve('.')).toThrow(/No workspace folder/);

    workspace.workspaceFolders = [{ uri: { fsPath: '/work/app' } }];
    fireWorkspaceFolders();
    expect(resolve('.').fsPath).toBe('/work/app');

    workspace.workspaceFolders = undefined;
    fireWorkspaceFolders();
    expect(() => resolve('.')).toThrow(/No workspace folder/);
  });
});
