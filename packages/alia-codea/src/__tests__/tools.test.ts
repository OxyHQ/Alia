import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ fsPath, path: fsPath });
  class FileSystemError extends Error {
    code = 'Unknown';
  }
  return {
    Uri: {
      file: (p: string) => uri(p),
      joinPath: (base: { fsPath: string }, ...parts: string[]) =>
        uri(path.join(base.fsPath, ...parts)),
    },
    FileSystemError,
    FileType: { Directory: 2, File: 1 },
    workspace: {
      workspaceFolders: [{ uri: uri('/work/space') }],
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
