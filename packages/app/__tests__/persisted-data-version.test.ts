import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALIA_ACCOUNT_QUERIES } from '@/shared/api/query-keys';
import { PERSISTED_DATA_VERSION } from '@/shared/api/persisted-data-version';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * The persisted cache survives deploys while `PERSISTED_DATA_VERSION` holds, and a restored query
 * is drawn before it is refreshed: read in a new shape, an old blob would crash the screen (Inbox
 * shipped exactly that when a hand-kept version was forgotten). So the version is not kept by
 * memory: this fingerprints the type declarations each persisted root is read with, and fails when
 * they change until the version is bumped and the fingerprint below is updated with it.
 *
 * Best effort by construction: it sees the files listed here. A new persisted root must list its
 * own (the second test), and a type a listed file imports from elsewhere must be listed too.
 */
const SHAPES: Record<string, string[]> = {
  // The SDK's types (the conversation list, a conversation, a gemie's profile) are covered by the
  // SDK's version, which `PERSISTED_DATA_STAMP` carries: an SDK upgrade drops the cache by itself.
  conversations: [],
  conversation: ['src/shared/api/persisted-conversations.ts'],
  'alia-agent-profile': [],
  skills: ['src/features/skills/runtime/use-skills.ts'],
  'conversation-collections': [],
};

/** Bump both together: `PERSISTED_DATA_VERSION`, and this to what the failure prints. */
const RECORDED = { version: 1, fingerprint: 'b15d7064c4f12859' };

/** Every `export interface|type` declaration, and every exported `const` that shapes the blob. */
function declarations(source: string): string[] {
  const found: string[] = [];
  const start = /^export (?:interface|type|const) \w+/gm;
  for (let match = start.exec(source); match; match = start.exec(source)) {
    let depth = 0;
    let i = match.index;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
      else if (c === '}' || c === ')' || c === ']' || c === '>') depth--;
      else if (depth <= 0 && (c === ';' || (c === '\n' && source[i - 1] === '}'))) break;
    }
    // Only declarations: a function's body is behaviour, not shape.
    const text = source.slice(match.index, i + 1);
    if (/^export const \w+ = (?:\(|async|function)/.test(text)) continue;
    found.push(text.replace(/\/\*\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, ' '));
  }
  return found;
}

function fingerprint(): string {
  const files = [...new Set(Object.values(SHAPES).flat())].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    for (const declaration of declarations(readFileSync(join(APP_ROOT, file), 'utf8'))) {
      hash.update(declaration);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

describe('the persisted data version', () => {
  it('moves with the shape of what is persisted', () => {
    const now = fingerprint();
    expect(
      { version: PERSISTED_DATA_VERSION, fingerprint: now },
      `A persisted type changed: bump PERSISTED_DATA_VERSION and set RECORDED to { version: ${
        PERSISTED_DATA_VERSION + 1
      }, fingerprint: '${now}' } (a version bump without a shape change is fine too).`,
    ).toEqual(RECORDED);
  });

  it('knows where every persisted root is typed', () => {
    expect([...ALIA_ACCOUNT_QUERIES.roots].sort()).toEqual(Object.keys(SHAPES).sort());
  });

  it('reads a declaration and ignores comments (the control)', () => {
    const one = declarations('/** a */\nexport interface A {\n  b: string; // c\n}\n');
    const two = declarations('export interface A {\n  b: string;\n}\n');
    expect(one).toEqual(two);
    expect(declarations('export interface A { b: number }\n')).not.toEqual(two);
  });
});
