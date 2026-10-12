import { describe, expect, it } from 'vitest';
import { codeOfFile, snippet } from '../../__tests__/support/source-code.js';
import path from 'node:path';

describe('agent stream admission ordering', () => {
  it('settles the durable turn before publishing DONE to the client', () => {
    // Canonical form (`__tests__/support/source-code.ts`): layout-independent.
    const source = codeOfFile(path.join(process.cwd(), 'src/lib/chat/provider-loop.ts'));
    const settle = source.indexOf(snippet('await beforeStreamClose()'));
    const done = source.indexOf(snippet("res.write('data: [DONE]\\n\\n')"), settle);

    expect(settle).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(settle);
  });
});
