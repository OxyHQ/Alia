import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { files, workspace } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  workspace: { root: '/work/space', scheme: 'file', authority: '' },
}));

vi.mock('vscode', () => {
  const uri = (fsPath: string, scheme = 'file', authority = '') => ({
    fsPath,
    path: fsPath,
    scheme,
    authority,
  });
  class FileSystemError extends Error {
    code = 'Unknown';
  }
  return {
    Uri: {
      file: (p: string) => uri(p),
      joinPath: (base: { fsPath: string; scheme: string; authority: string }, ...parts: string[]) =>
        uri(
          (base.fsPath.includes('\\') ? path.win32 : path.posix).join(base.fsPath, ...parts),
          base.scheme,
          base.authority,
        ),
    },
    FileSystemError,
    FileType: { Directory: 2, File: 1 },
    workspace: {
      get workspaceFolders() {
        return [{ uri: uri(workspace.root, workspace.scheme, workspace.authority) }];
      },
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      fs: {
        readFile: async (u: { fsPath: string }) =>
          new TextEncoder().encode(files.get(u.fsPath) ?? ''),
        writeFile: async (u: { fsPath: string }, bytes: Uint8Array) => {
          files.set(u.fsPath, new TextDecoder().decode(bytes));
        },
      },
      openTextDocument: async (u: unknown) => u,
    },
    window: { showTextDocument: async () => undefined },
  };
});

import { ToolExecutor } from '../tools';

beforeEach(() => {
  files.clear();
  workspace.root = '/work/space';
  workspace.scheme = 'file';
  workspace.authority = '';
});

describe('Codea ToolExecutor containment', () => {
  it('refuses paths outside the workspace, relative or absolute', async () => {
    files.set('/etc/passwd', 'root');
    files.set('/work/space-backup/x', 'x');
    const tools = new ToolExecutor();
    for (const p of ['/etc/passwd', '../../etc/passwd', '/work/space-backup/x']) {
      const res = await tools.execute('read_file', { path: p });
      expect(res.success).toBe(false);
      expect(res.result).toMatch(/outside the workspace/);
    }
  });

  it('allows relative paths and absolute paths inside the workspace', async () => {
    files.set('/work/space/a.txt', 'hello');
    const tools = new ToolExecutor();
    expect((await tools.execute('read_file', { path: 'a.txt' })).result).toContain('hello');
    expect((await tools.execute('read_file', { path: '/work/space/a.txt' })).result).toContain(
      'hello',
    );
  });

  it('keeps Windows drive and traversal boundaries in browser-compatible path handling', async () => {
    workspace.root = String.raw`C:\work\space`;
    files.set(String.raw`C:\work\space\ok.txt`, 'windows file');
    const tools = new ToolExecutor();
    expect((await tools.execute('read_file', { path: 'ok.txt' })).result).toContain('windows file');
    expect(
      (await tools.execute('read_file', { path: String.raw`C:\work\space\ok.txt` })).success,
    ).toBe(true);
    for (const target of [
      String.raw`D:\work\space\ok.txt`,
      String.raw`C:\work\space-backup\secret`,
      String.raw`..\secret`,
    ]) {
      expect((await tools.execute('read_file', { path: target })).success).toBe(false);
    }
    tools.dispose();
  });

  it('keeps virtual workspace reads on their original URI authority', async () => {
    workspace.scheme = 'vscode-remote';
    workspace.authority = 'ssh-remote+host';
    files.set('/work/space/ok.txt', 'remote file');
    const tools = new ToolExecutor();
    expect((await tools.execute('read_file', { path: 'ok.txt' })).result).toContain('remote file');
    // A local file URI with the same path is not the remote workspace.
    expect((await tools.execute('read_file', { path: '/work/space/ok.txt' })).success).toBe(false);
    tools.dispose();
  });

  it('editFile inserts new_text literally', async () => {
    files.set('/work/space/b.txt', 'x OLD y');
    const tools = new ToolExecutor();
    const res = await tools.execute('edit_file', {
      path: 'b.txt',
      old_text: 'OLD',
      new_text: '$& $1 $$',
    });
    expect(res.success).toBe(true);
    expect(files.get('/work/space/b.txt')).toBe('x $& $1 $$ y');
  });
});
