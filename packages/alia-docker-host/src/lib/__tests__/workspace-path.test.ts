import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_ROOT,
  normalizeWorkspacePath,
  shellEscape,
  shortId,
} from '../workspace-path';

/**
 * `@alia/docker-host`'s first test.
 *
 * ## Why this package and why these functions
 *
 * The package had no `test` script, no `typecheck` script and not one
 * reference in `.github/workflows/ci.yml` — 984 lines of code that runs
 * arbitrary commands inside containers on behalf of an agent, with nothing
 * checking any of it. These two functions are the security-relevant part of
 * it: `normalizeWorkspacePath` decides whether a caller-supplied path stays
 * under `/workspace`, and `shellEscape` decides whether a caller-supplied
 * string stays an argument instead of becoming a command.
 *
 * They were unreachable by any test until this change, and not for a subtle
 * reason: they lived in `docker.ts`, which constructs a Dockerode client at
 * import time and imports `log` from `../index.js` — the server entrypoint. So
 * importing the module to test a string function started the service. Moving
 * them to `workspace-path.ts` is what makes the file below possible.
 *
 * ## What the cases are chosen for
 *
 * Traversal is asserted in the forms it actually arrives in — bare, nested,
 * disguised behind a `workspace/` prefix, and backslash-separated, since the
 * function normalises `\` to `/` before splitting and so must not be fooled by
 * `..\..`. The quoting cases are the ones where a naive escape leaks: an
 * embedded single quote, and the characters that would matter if the quoting
 * ever stopped working.
 */

describe('normalizeWorkspacePath', () => {
  it('resolves ordinary paths under the workspace root', () => {
    expect(normalizeWorkspacePath('src/index.ts')).toBe('/workspace/src/index.ts');
    expect(normalizeWorkspacePath('/src/index.ts')).toBe('/workspace/src/index.ts');
    expect(normalizeWorkspacePath('workspace/src/index.ts')).toBe('/workspace/src/index.ts');
    expect(normalizeWorkspacePath('/workspace/src/index.ts')).toBe('/workspace/src/index.ts');
  });

  it('answers the root itself for the forms that name it', () => {
    expect(normalizeWorkspacePath('workspace')).toBe(WORKSPACE_ROOT);
    expect(normalizeWorkspacePath('/workspace')).toBe(WORKSPACE_ROOT);
    expect(normalizeWorkspacePath('/')).toBe(WORKSPACE_ROOT);
    expect(normalizeWorkspacePath('.')).toBe(WORKSPACE_ROOT);
    expect(normalizeWorkspacePath('./')).toBe(WORKSPACE_ROOT);
  });

  it('collapses redundant separators and `.` segments', () => {
    expect(normalizeWorkspacePath('src//lib///a.ts')).toBe('/workspace/src/lib/a.ts');
    expect(normalizeWorkspacePath('./src/./a.ts')).toBe('/workspace/src/a.ts');
  });

  it('normalises backslashes, so a Windows-style path lands in the same place', () => {
    expect(normalizeWorkspacePath('src\\lib\\a.ts')).toBe('/workspace/src/lib/a.ts');
  });

  it('REFUSES traversal rather than sanitising it', () => {
    // Refusing, not dropping: a caller that sent `..` is asking for something
    // this function cannot give, and silently returning a different path is how
    // a caller comes to believe it wrote somewhere it did not.
    for (const attempt of [
      '..',
      '../etc/passwd',
      'src/../../etc/passwd',
      '/workspace/../etc/passwd',
      'workspace/../../etc/passwd',
      // The backslash form, which only fails to be caught if the `\` → `/`
      // normalisation happens after the split rather than before it.
      '..\\..\\etc\\passwd',
    ]) {
      expect(() => normalizeWorkspacePath(attempt), attempt).toThrow(/traversal/i);
    }
  });

  it('refuses an empty path and a NUL byte', () => {
    // Everything downstream is C, where a NUL truncates: `a\0/../../etc` is one
    // string here and another one there.
    for (const attempt of ['', '   ', 'src/a\0.ts', '\0']) {
      expect(() => normalizeWorkspacePath(attempt), JSON.stringify(attempt)).toThrow(/Invalid path/);
    }
  });

  it('never returns a path outside the workspace root', () => {
    // The property, stated once over everything above that does not throw.
    for (const input of [
      'a',
      '/a',
      'workspace/a',
      './a/./b',
      'a//b',
      'a\\b',
      'workspace',
      '/',
      '...',
      '.hidden',
      'file with spaces.txt',
    ]) {
      const resolved = normalizeWorkspacePath(input);
      expect(resolved === WORKSPACE_ROOT || resolved.startsWith(`${WORKSPACE_ROOT}/`), input).toBe(
        true,
      );
    }
  });

  it('treats `...` as an ordinary name, not as traversal', () => {
    // Only exactly `..` is a parent reference; over-refusing would make a
    // legitimate file unreachable.
    expect(normalizeWorkspacePath('...')).toBe('/workspace/...');
    expect(normalizeWorkspacePath('..foo')).toBe('/workspace/..foo');
  });
});

describe('shellEscape', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'");
  });

  it('keeps an embedded single quote from closing the argument', () => {
    // `'` closes the quote, so it is emitted as `'\''`: close, escaped literal
    // quote, reopen. This is the whole reason the function exists.
    expect(shellEscape("it's")).toBe(`'it'\\''s'`);
    expect(shellEscape("'; rm -rf /; echo '")).toBe(`''\\''; rm -rf /; echo '\\'''`);
  });

  it('leaves shell metacharacters literal', () => {
    // Inside single quotes none of these are special, which is what makes the
    // one rule above sufficient.
    for (const value of ['$HOME', '`id`', 'a;b', 'a|b', 'a&b', 'a\nb', '$(id)', 'a>b']) {
      expect(shellEscape(value)).toBe(`'${value}'`);
    }
  });

  it('escapes every quote in a value, not only the first', () => {
    expect(shellEscape("a'b'c")).toBe(`'a'\\''b'\\''c'`);
  });
});

describe('shortId', () => {
  it('takes Docker short form, and is idempotent', () => {
    const full = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    expect(shortId(full)).toBe('abcdef012345');
    // The activity map is keyed on this, and callers hand in both forms — so
    // `touch` with a full id and `forget` with a short one must agree.
    expect(shortId(shortId(full))).toBe(shortId(full));
  });

  it('leaves an already-short id alone', () => {
    expect(shortId('abc123')).toBe('abc123');
  });
});
