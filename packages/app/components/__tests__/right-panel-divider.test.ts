import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('right panel divider', () => {
  it('does not draw a second border beside the framed content panel', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../right-panel.tsx'), 'utf8');

    expect(source).toMatch(/<Panel[\s\S]*?side="right"[\s\S]*?divided=\{false\}/);
  });
});
