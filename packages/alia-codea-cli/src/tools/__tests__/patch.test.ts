/**
 * The patch tool, which is the CLI's most dangerous surface.
 *
 * ## Why this file exists
 *
 * `@alia-codea/cli` ships to npm, applies diffs a language model wrote, and in
 * `--approval-mode auto-edit` and `full-auto` does so with nobody in the loop.
 * Until this file, the package had no test of any kind: three defects below
 * were live in a published release, and every one of them fails silently —
 * a wrong-but-plausible result, never an exception.
 *
 * Each `describe` names the defect it pins. The fixtures are real unified-diff
 * text rather than hand-built `FilePatch` objects, because the parser is half
 * of what is under test and a test that constructs the parsed form measures
 * only `applyPatch`.
 *
 * Every apply runs against a real temporary directory. A mocked `fs` would
 * accept a write to `/etc/passwd` as readily as one to `src/index.ts`, and
 * "did it write outside the base directory" is the exact question three of
 * these tests ask.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyPatch, parsePatch, resolveInside } from '../patch.js';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'alia-patch-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function seed(relative: string, content: string): Promise<void> {
  const target = path.join(base, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

const read = (relative: string) => readFile(path.join(base, relative), 'utf8');

describe('a hunk body is consumed by its declared counts', () => {
  /**
   * The defect: any line starting with `--- ` was treated as the beginning of
   * a new file header. A DELETED line whose own content starts with `-- ` is
   * written `--- ` in a diff — an SQL comment, a `--flag` in prose — so
   * deleting one ended the current file patch and opened a bogus one named
   * after whatever followed.
   */
  it('reads a deleted `-- ` line as content, not as a file header', async () => {
    await seed('schema.sql', '-- keep\n-- drop me\nSELECT 1;\n');

    const patch = [
      '--- a/schema.sql',
      '+++ b/schema.sql',
      '@@ -1,3 +1,2 @@',
      ' -- keep',
      '--- drop me',
      ' SELECT 1;',
      '',
    ].join('\n');

    const parsed = parsePatch(patch);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].filePath).toBe('schema.sql');

    const result = await applyPatch(patch, base);
    expect(result.results[0].message).not.toMatch(/outside|not find/);
    expect(result.success).toBe(true);
    expect(await read('schema.sql')).toBe('-- keep\nSELECT 1;\n');
  });

  it('reads an added `++ ` line as content, not as a file header', async () => {
    await seed('notes.md', 'alpha\n');

    const patch = ['--- a/notes.md', '+++ b/notes.md', '@@ -1,1 +1,2 @@', ' alpha', '+++ beta', ''].join(
      '\n',
    );

    expect(parsePatch(patch)).toHaveLength(1);
    await applyPatch(patch, base);
    expect(await read('notes.md')).toBe('alpha\n++ beta\n');
  });

  it('skips a `\\ No newline at end of file` marker', () => {
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '',
    ].join('\n');

    const [file] = parsePatch(patch);
    expect(file.hunks[0].oldLines).toEqual(['old']);
    expect(file.hunks[0].newLines).toEqual(['new']);
    expect(file.noTrailingNewline).toBe(true);
  });

  it('keeps two files in a multi-file patch separate', () => {
    const patch = [
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,1 +1,1 @@',
      '-one',
      '+ONE',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,1 +1,1 @@',
      '-two',
      '+TWO',
      '',
    ].join('\n');

    expect(parsePatch(patch).map((f) => f.filePath)).toEqual(['one.txt', 'two.txt']);
  });
});

describe('a path out of the patch cannot escape the base directory', () => {
  /**
   * The defect: `path.resolve(basePath, filePatch.filePath)`. `path.resolve`
   * lets an ABSOLUTE path win outright, so this was never only about `../`.
   */
  it('refuses a relative traversal', async () => {
    const patch = [
      '--- a/../../escaped.txt',
      '+++ b/../../escaped.txt',
      '@@ -0,0 +1,1 @@',
      '+owned',
      '',
    ].join('\n');

    const result = await applyPatch(patch, base);
    expect(result.success).toBe(false);
    expect(result.results[0].message).toMatch(/outside the working directory/);
    expect(existsSync(path.join(base, '..', '..', 'escaped.txt'))).toBe(false);
  });

  it('refuses an absolute path', async () => {
    // No `a/` or `b/` prefix: this is how an absolute path appears in a diff
    // header, and it is the form `path.resolve` used to honour outright.
    const outside = path.join(tmpdir(), `alia-escape-${String(process.pid)}.txt`);
    const patch = [
      `--- ${outside}`,
      `+++ ${outside}`,
      '@@ -0,0 +1,1 @@',
      '+owned',
      '',
    ].join('\n');

    const result = await applyPatch(patch, base);
    expect(result.success).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });

  it('refuses a sibling directory that merely shares a name prefix', () => {
    // A string-prefix containment test says `/repo-backup` is inside `/repo`.
    expect(resolveInside('/repo', '../repo-backup/x')).toBeNull();
  });

  it('accepts an ordinary nested path', () => {
    expect(resolveInside('/repo', 'src/a/b.ts')).toBe(path.resolve('/repo/src/a/b.ts'));
  });

  it('accepts the base itself only when the caller allows it', () => {
    expect(resolveInside('/repo', '.')).toBeNull();
    expect(resolveInside('/repo', '.', true)).toBe(path.resolve('/repo'));
  });
});

describe('a hunk that could apply in two places applies in neither', () => {
  /**
   * The defect: the fuzzy search returned the FIRST position within ±20 lines
   * that matched. A file with a repeated block — two identical error branches,
   * a duplicated import group — got the wrong one patched, and the tool
   * reported success.
   */
  it('refuses an ambiguous hunk instead of guessing', async () => {
    const block = ['try {', '  run();', '} catch {', '  log();', '}'];
    await seed('dup.ts', [...block, 'const gap = 1;', ...block, ''].join('\n'));

    // Line 4 is inside neither copy exactly, and both copies sit within drift.
    const patch = [
      '--- a/dup.ts',
      '+++ b/dup.ts',
      '@@ -4,2 +4,2 @@',
      '-} catch {',
      '-  log();',
      '+} catch (err) {',
      '+  log(err);',
      '',
    ].join('\n');

    const result = await applyPatch(patch, base);
    expect(result.success).toBe(false);
    expect(result.results[0].message).toMatch(/more than one place/);
    // The file is untouched — a refusal that half-applied would be worse than
    // the guess it replaced.
    expect(await read('dup.ts')).toContain('} catch {\n  log();');
  });

  it('still applies a hunk whose line number drifted, when it is unambiguous', async () => {
    await seed('drift.ts', ['// a new banner line', 'const value = 1;', 'export {};', ''].join('\n'));

    const patch = [
      '--- a/drift.ts',
      '+++ b/drift.ts',
      '@@ -1,1 +1,1 @@',
      '-const value = 1;',
      '+const value = 2;',
      '',
    ].join('\n');

    const result = await applyPatch(patch, base);
    expect(result.success).toBe(true);
    expect(await read('drift.ts')).toBe('// a new banner line\nconst value = 2;\nexport {};\n');
  });
});

describe('git file creation and deletion', () => {
  /**
   * The defect: the file name was taken from the `+++` side unconditionally.
   * Git writes a DELETION as `+++ /dev/null`, which `path.resolve` turned into
   * the absolute path `/dev/null` — outside the base directory, and nothing
   * about the result said so.
   */
  it('deletes the file named on the `---` side', async () => {
    await seed('gone.txt', 'bye\n');

    const patch = ['--- a/gone.txt', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye', ''].join('\n');

    const result = await applyPatch(patch, base);
    expect(result.success).toBe(true);
    expect(result.results[0].file).toBe('gone.txt');
    expect(existsSync(path.join(base, 'gone.txt'))).toBe(false);
  });

  it('creates a file the patch introduces, with a trailing newline', async () => {
    const patch = [
      '--- /dev/null',
      '+++ b/nested/new.txt',
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
      '',
    ].join('\n');

    const result = await applyPatch(patch, base);
    expect(result.success).toBe(true);
    expect(await read('nested/new.txt')).toBe('first\nsecond\n');
  });

  it('honours `\\ No newline at end of file` on a created file', async () => {
    const patch = [
      '--- /dev/null',
      '+++ b/tight.txt',
      '@@ -0,0 +1,1 @@',
      '+only',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    await applyPatch(patch, base);
    expect(await read('tight.txt')).toBe('only');
  });
});

describe('ordinary application', () => {
  it('applies several hunks to one file without disturbing the others', async () => {
    await seed(
      'multi.ts',
      ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', ''].join('\n'),
    );

    const patch = [
      '--- a/multi.ts',
      '+++ b/multi.ts',
      '@@ -2,1 +2,1 @@',
      '-two',
      '+TWO',
      '@@ -7,1 +7,1 @@',
      '-seven',
      '+SEVEN',
      '',
    ].join('\n');

    const result = await applyPatch(patch, base);
    expect(result.success).toBe(true);
    expect(await read('multi.ts')).toBe(
      ['one', 'TWO', 'three', 'four', 'five', 'six', 'SEVEN', 'eight', ''].join('\n'),
    );
  });

  it('reports a per-file failure without abandoning the other files', async () => {
    await seed('good.txt', 'keep\n');

    const patch = [
      '--- a/good.txt',
      '+++ b/good.txt',
      '@@ -1,1 +1,1 @@',
      '-keep',
      '+kept',
      '--- a/missing.txt',
      '+++ b/missing.txt',
      '@@ -1,1 +1,1 @@',
      '-nothing',
      '+something',
      '',
    ].join('\n');

    const result = await applyPatch(patch, base);
    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ file: 'good.txt', success: true });
    expect(result.results[1]).toMatchObject({ file: 'missing.txt', success: false });
    expect(await read('good.txt')).toBe('kept\n');
  });

  it('matches a context line whose trailing whitespace drifted', async () => {
    await seed('ws.ts', 'const a = 1;   \nconst b = 2;\n');

    const patch = [
      '--- a/ws.ts',
      '+++ b/ws.ts',
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '',
    ].join('\n');

    const result = await applyPatch(patch, base);
    expect(result.success).toBe(true);
    // The hunk still LOCATES the range, which is the point — a model rarely
    // reproduces trailing whitespace and the alternative is a spurious "could
    // not find match". The range is then replaced by the lines the patch
    // carries, context included, so the drifted whitespace does not survive.
    // That is what `git apply` does too; it is recorded here so a later reader
    // knows it was measured rather than assumed.
    expect(await read('ws.ts')).toBe('const a = 1;\nconst b = 3;\n');
  });
});
