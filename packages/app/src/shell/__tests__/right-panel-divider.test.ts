import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('right panel divider', () => {
  it('does not draw a second border beside the framed content panel', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../workspace-panel.tsx'),
      'utf8',
    );

    expect(source).not.toMatch(/<Panel[\s>]/);
    const shell = readFileSync(
      resolve(import.meta.dirname, '../../../app/(app)/_layout.tsx'),
      'utf8',
    );
    expect(shell).toContain('<AiChatShell');
    expect(shell).toContain('<WorkspacePanel width={width} />');
  });
});
