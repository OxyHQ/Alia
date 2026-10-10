import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSource, codeOfFile, snippet } from '../source-code';

const APP = join(__dirname, '..', '..', '..', '..');

/** Every file a source-reading test in this package pins through `codeOfFile`. */
const PINNED = [
  'index.web.tsx',
  'src/features/chat/runtime/use-chat-conversation.ts',
  'src/features/chat/runtime/use-conversations.ts',
];

describe('the canonical source form', () => {
  it('ignores layout, quote style, comments and trailing commas', () => {
    const tidy = "renderRootComponent(flag === '1' ? require('./entry').A : App);";
    const wrapped = `renderRootComponent(
      flag === "1" // the build-time flag
        ? require("./entry").A
        : App,
    );`;
    expect(snippet(wrapped)).toBe(snippet(tidy));
    expect(canonicalSource(wrapped)).toBe(snippet(tidy));
  });

  it('still tells different code apart', () => {
    expect(snippet("flag === '1'")).not.toBe(snippet("flag === '0'"));
    expect(snippet('a ? b : c')).not.toBe(snippet('a ? c : b'));
  });

  it.each(PINNED)('agrees with the parser on all of %s', (relative) => {
    // A snippet goes through the scanner and a file through the parser, so a
    // match only means anything if the two agree on whole files.
    const absolute = join(APP, relative);
    expect(snippet(readFileSync(absolute, 'utf8'))).toBe(codeOfFile(absolute));
    expect(codeOfFile(absolute).length).toBeGreaterThan(200);
  });
});
