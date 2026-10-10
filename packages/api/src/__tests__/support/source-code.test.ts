import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalSource, codeOfFile, snippet } from './source-code.js';

const API_SRC = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Every file a source-reading test pins through `codeOfFile`. They are
 * formatted like any other file, so what this guards is that the canonical form
 * is the same whichever way the file is laid out.
 */
const PINNED = [
  'index.ts',
  'routes/chat.ts',
  'routes/v1.ts',
  'routes/v1/chat-completions.ts',
  'lib/chat/provider-loop.ts',
  'lib/chat/request-context.ts',
  'lib/credits-manager.ts',
  'lib/agent/orchestrator.ts',
  'db/agents/agentSessionRepository.ts',
  'domain/credit-funding.ts',
];

describe('the canonical source form', () => {
  it('ignores layout, quote style, comments and trailing commas', () => {
    const tidy = "router.use('/v1', cors({ origin: '*' }));";
    const wrapped = `router.use(
      "/v1", // the wildcard
      cors({
        origin: "*",
      }),
    );`;
    expect(snippet(wrapped)).toBe(snippet(tidy));
    expect(canonicalSource(wrapped)).toBe(snippet(tidy));
    expect(snippet(tidy)).toBe("router.use('/v1',cors({origin:'*'}));");
  });

  it('still tells different code apart', () => {
    // The negative control: a canonical form that erased the difference
    // between these would pass every assertion built on it.
    expect(snippet("cors({ origin: '*' })")).not.toBe(snippet("cors({ origin: '+' })"));
    expect(snippet('return await x')).not.toBe(snippet('returnawait x'));
    expect(snippet('a ? b : c')).not.toBe(snippet('a ? c : b'));
    expect(snippet("f('a', 'b')")).not.toBe(snippet("f('a,b')"));
  });

  it('reads templates and regex literals in a snippet as the parser does', () => {
    const source = `const r = /a\\/b"/g; const t = \`x \${y ? \`n\${z}\` : "q"} w\`; const d = a / b;`;
    expect(snippet(source)).toBe(canonicalSource(source));
  });

  it.each(PINNED)('agrees with the parser on all of %s', (relative) => {
    const absolute = path.join(API_SRC, relative);
    // The scanner and the parser are two tokenisers. A snippet goes through
    // one and the file through the other, so a match only means anything if
    // they agree; on a whole file, they must agree exactly.
    expect(snippet(readFileSync(absolute, 'utf8'))).toBe(codeOfFile(absolute));
    // The floor: the file was read and is not empty.
    expect(codeOfFile(absolute).length).toBeGreaterThan(200);
  });
});
