import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeTool } from '../executor.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'alia-edit-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('edit_file', () => {
  it('inserts new_text literally, without $ replacement patterns', async () => {
    await writeFile(path.join(dir, 'f.txt'), 'a OLD b');
    const res = await executeTool('edit_file', {
      path: 'f.txt',
      old_text: 'OLD',
      new_text: "$& $1 $$ $'",
    });
    expect(res.success).toBe(true);
    expect(await readFile(path.join(dir, 'f.txt'), 'utf8')).toBe("a $& $1 $$ $' b");
  });
});
