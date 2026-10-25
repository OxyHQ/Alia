import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openPath } = vi.hoisted(() => ({ openPath: vi.fn() }));

vi.mock('electron', () => ({
  clipboard: {},
  shell: { openPath },
  desktopCapturer: {},
  BrowserWindow: class {},
}));
vi.mock('@browserbasehq/stagehand', () => ({ Stagehand: class {} }));
vi.mock('electron-store', () => ({
  default: class {
    get() {}
    set() {}
  },
}));
vi.mock('../auth', () => ({ linkedAliaClient: vi.fn(), onSessionContextChange: () => () => {} }));
vi.mock('../stagehand-transport', () => ({ stagehandClientForTransport: vi.fn() }));
vi.mock('../catalogue', () => ({ resolveRequiredModelId: vi.fn() }));

import { ToolExecutor } from '../tools';

let dir: string;

function executorFor(root: string): ToolExecutor {
  const tools = new ToolExecutor();
  tools.grantRoot(root);
  return tools;
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-tools-')));
  openPath.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ToolExecutor hardening', () => {
  it('granting a file does not grant its sibling files', async () => {
    const granted = path.join(dir, 'a.txt');
    fs.writeFileSync(granted, 'hello');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
    const tools = executorFor(granted);
    await expect(tools.readFile({ path: granted })).resolves.toContain('hello');
    await expect(tools.readFile({ path: path.join(dir, 'secret.txt') })).rejects.toThrow(/outside/);
  });

  it('searchFiles passes the pattern as an argument, not to a shell', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'needle\n');
    const marker = path.join(dir, 'pwned');
    const tools = executorFor(dir);
    const out = await tools.searchFiles({ pattern: `x"; touch ${marker}; echo "` });
    expect(out).toBe('No matches found');
    expect(fs.existsSync(marker)).toBe(false);
    await expect(tools.searchFiles({ pattern: 'needle' })).resolves.toContain('needle');
  });

  it('open_application reports the error string openPath returns', async () => {
    openPath.mockResolvedValue('Failed to open path');
    const tools = new ToolExecutor();
    await expect(tools.openApplication({ application_name: 'nope' })).rejects.toThrow(
      /Failed to open path/,
    );
  });

  it('editFile inserts new_text literally, without $ replacement patterns', async () => {
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'price: OLD');
    const tools = executorFor(dir);
    await tools.editFile({ path: file, old_text: 'OLD', new_text: "$& $1 $$ $'" });
    expect(fs.readFileSync(file, 'utf-8')).toBe("price: $& $1 $$ $'");
  });
});
