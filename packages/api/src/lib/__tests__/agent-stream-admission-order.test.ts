import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('agent stream admission ordering', () => {
  it('settles the durable turn before publishing DONE to the client', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/chat/provider-loop.ts'), 'utf8');
    const settle = source.indexOf('await beforeStreamClose()');
    const done = source.indexOf("res.write('data: [DONE]\\n\\n')", settle);

    expect(settle).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(settle);
  });
});
