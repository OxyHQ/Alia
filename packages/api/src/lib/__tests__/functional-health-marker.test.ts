import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('passive functional health marker', () => {
  it('emits one metadata-free marker from both completed hosted paths', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/chat/provider-loop.ts'), 'utf8');
    expect(source.match(/log\.v1\.info\('Alia functional turn completed'\);/g)).toHaveLength(2);
    expect(source).not.toMatch(/log\.v1\.info\(\{[^)]*Alia functional turn completed/);
  });
});
