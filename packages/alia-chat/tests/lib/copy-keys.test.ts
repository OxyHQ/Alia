import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COPY_EN } from '../../src/lib/copy-en';
import { englishCopy } from '../../src/lib/copy';

/**
 * Every word the chat asks for by key is one it can say.
 *
 * The thread, its cards, the thought panel and the work log do not read fixed `labels` fields:
 * they ask the translator (`labels.t`) for a key, and a host that brings no translator reads the
 * SDK's English (`copy-en.ts`). A key a component asks for and the English lacks does not fail —
 * `englishCopy` answers a missing key with the key itself — it reads `chat.turnFailed` on a
 * person's screen. So the source is scanned for every literal key and for the prefix of every
 * computed one, and each must be in the table.
 */

const SRC = join(__dirname, '../../src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('copy-en.ts') ? [path] : [];
  });
}

/** Source with comments dropped, so prose that quotes a call cannot be counted as one. */
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const files = sources(SRC);
const keys = Object.keys(COPY_EN);

/** `t('a.b')`, with the translator under any of the names the chat gives it. */
const LITERAL = /\b(?:t|translate)\(\s*'([\w.]+)'/g;
/** `t(`a.b.${x}`)`: the part before the first `${`. */
const COMPUTED = /\b(?:t|translate)\(\s*`([\w.]+)\$\{/g;

function found(pattern: RegExp): Map<string, string> {
  const seen = new Map<string, string>();
  for (const file of files) {
    for (const match of code(file).matchAll(pattern)) {
      seen.set(match[1] as string, file.slice(SRC.length + 1));
    }
  }
  return seen;
}

describe('the chat’s English', () => {
  it('has every key the source asks for by name', () => {
    const missing = [...found(LITERAL)].filter(([key]) => !(key in COPY_EN));
    expect(missing).toEqual([]);
  });

  it('has something behind every key the source computes', () => {
    const missing = [...found(COMPUTED)].filter(
      ([prefix]) => !keys.some((key) => key.startsWith(prefix)),
    );
    expect(missing).toEqual([]);
  });

  it('scans something: the source asks for more than a handful of keys', () => {
    // A pattern that stopped matching would pass the two cases above while measuring nothing.
    expect(found(LITERAL).size).toBeGreaterThan(60);
    expect(found(COMPUTED).size).toBeGreaterThan(0);
  });

  it('writes every plural with the form that answers any count', () => {
    for (const [key, entry] of Object.entries(COPY_EN)) {
      if (typeof entry === 'string') continue;
      expect(entry.other, key).toBeTypeOf('string');
    }
  });

  it('says a plural by its count and fills the parameters in', () => {
    expect(englishCopy('thought.audit.planSteps', { count: 1 })).toBe('1 step');
    expect(englishCopy('thought.audit.planSteps', { count: 3 })).toBe('3 steps');
    expect(englishCopy('thought.workedFor', { elapsed: '2m' })).toBe('Worked for 2m');
  });

  it('answers a key it does not know with the key, so a missing word is seen and not blank', () => {
    expect(englishCopy('no.such.key')).toBe('no.such.key');
  });
});
