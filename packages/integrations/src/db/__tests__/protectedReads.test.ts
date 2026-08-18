/**
 * Two gates over this package's own source, both of which exist because the
 * thing they check is invisible at runtime.
 *
 *  1. **No implicit whole-row read.** `publicColumns` cannot defend against not
 *     being called: a bare `db.select().from(telegramSessions)` returns every
 *     column, `sessionString` included, and nothing at the call site names what
 *     it just handed out. Only a scan of the call sites catches that.
 *  2. **Mongoose is gone.** Not "mostly gone" — a single surviving import would
 *     mean a second, unmigrated source of truth for rows this package now owns
 *     in Postgres, and it would fail at boot rather than in a test.
 *
 * Each gate has a positive control beside it, because a scan that reports zero
 * findings and a scan that reads nothing are the same result. The scanner is
 * pointed at a directory whose contents are KNOWN to violate the rule, and the
 * census is re-run for a symbol that is known to be present.
 */

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findImplicitWholeRowReads } from '@oxyhq/db/assert';
import { PROTECTED_COLUMNS } from '../protectedColumns';

const PACKAGE_ROOT = join(__dirname, '..', '..', '..');
const SOURCE_DIR = join(PACKAGE_ROOT, 'src');

/**
 * A floor only this package can set. `findImplicitWholeRowReads` reports
 * vacuity at ZERO files, which catches a broken path but not a traversal that
 * reached a fraction of the tree. This package has around fifty source files;
 * a run that sees under thirty is measuring something other than the tree.
 */
const MINIMUM_SOURCE_FILES = 30;

/** Every `.ts` file the gates apply to: the source, never the tests. */
async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      found.push(...(await sourceFiles(path)));
      continue;
    }
    if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

/**
 * Files whose CODE imports `specifier`. Comments are blanked first: this
 * package's own doc comments name Mongoose repeatedly on purpose, and a census
 * that counted those would be measuring prose.
 */
async function filesImporting(specifier: string): Promise<string[]> {
  const pattern = new RegExp(String.raw`(?:from|require\()\s*['"]${specifier}`);
  const matches: string[] = [];
  for (const file of await sourceFiles(SOURCE_DIR)) {
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    if (pattern.test(code)) matches.push(file);
  }
  return matches;
}

describe('no read returns a protected column without naming it', () => {
  it('finds no implicit whole-row read in this package', async () => {
    const violations = await findImplicitWholeRowReads({
      sourceDir: SOURCE_DIR,
      registry: PROTECTED_COLUMNS,
    });
    expect(violations).toEqual([]);
  });

  it('sees a tree of the size this package actually is', async () => {
    expect((await sourceFiles(SOURCE_DIR)).length).toBeGreaterThanOrEqual(MINIMUM_SOURCE_FILES);
  });

  it('DOES flag a bare select, so the clean result above means something', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'alia-implicit-read-'));
    await writeFile(
      join(directory, 'leak.ts'),
      [
        "import { telegramSessions } from '../db/schema';",
        'export const rows = () => db.select().from(telegramSessions);',
        '',
      ].join('\n'),
    );

    const violations = await findImplicitWholeRowReads({
      sourceDir: directory,
      registry: PROTECTED_COLUMNS,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.subject).toBe('leak.ts:2');
  });
});

describe('nothing in this package reaches Mongo any more', () => {
  it('imports mongoose nowhere in src', async () => {
    expect(await filesImporting('mongoose')).toEqual([]);
  });

  it('does not declare mongoose as a dependency', async () => {
    const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('mongoose');
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain('mongoose');
    // The positive control for the manifest read itself.
    expect(Object.keys(manifest.dependencies ?? {})).toContain('drizzle-orm');
  });

  it('finds the imports it IS looking for, so the empty result is not vacuous', async () => {
    const drizzleImporters = await filesImporting('drizzle-orm');
    expect(drizzleImporters.length).toBeGreaterThan(5);
  });
});
