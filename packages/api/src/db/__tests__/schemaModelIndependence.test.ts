import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every closed value set lives in `src/domain/`, and every module there is a
 * LEAF: it imports nothing.
 *
 * Each tuple renders a CHECK constraint, so the SCHEMA — and therefore every
 * migration's CHECK — depends on it. A `domain` module that imports anything
 * (for an interface, say) lets `db/schema/index.ts` depend on whatever that
 * import reaches, and a failure to load the schema is one `drizzle-kit` reports
 * by generating NOTHING while exiting 0. That is the single-tuple rule in
 * `CONVENTIONS.md` ("Closed value sets").
 *
 * ## Why a test rather than a convention
 *
 * The regression is one `import` line in a new domain file, it typechecks, and
 * every suite stays green. It only bites on the day the imported module moves
 * or is deleted, in a different PR, as a failure that names the deleter rather
 * than the author. This is the one moment the rule is cheap to enforce.
 */

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * `git ls-files` rather than a directory walk: it reports the INDEX, so it
 * cannot disagree with what git tracks and excludes build output for free.
 *
 * A path can remain in the index while an intentional removal is unstaged in a
 * review worktree. Scan every tracked source that still exists; the migration
 * gates cover the removal itself.
 */
function trackedSources(prefix: string): { file: string; text: string }[] {
  return execFileSync('git', ['ls-files', '--', prefix], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => existsSync(path.join(PACKAGE_ROOT, f)))
    .map((file) => ({ file, text: readFileSync(path.join(PACKAGE_ROOT, file), 'utf8') }));
}

/**
 * Every module specifier, whatever the quote style and whatever the import form.
 *
 * The quote class is not decoration: this package mixes `'` and `"`, and a
 * single-quote-only pattern silently misses `lib/tools/user-memory.ts`. A
 * scanner that reads less looks exactly like a codebase that has less.
 */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
/** `import 'x'` and `await import('x')`, which the form above cannot see. */
const BARE_IMPORT = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPECIFIER)) out.push(m[1]);
  for (const m of text.matchAll(BARE_IMPORT)) out.push(m[1] ?? m[2]);
  return out;
}

/**
 * The scanner, pinned against literal buffers.
 *
 * Every file under `db/schema` happens to use single quotes today, so narrowing
 * the pattern to `'` alone leaves every assertion below GREEN — measured, not
 * assumed. That is a gate which cannot fail for the case it is most likely to
 * miss, because this package genuinely mixes quote styles elsewhere. The forms
 * are therefore asserted here rather than being left to whatever the current
 * schema files happen to look like.
 */
describe('the import scanner recognises every form a specifier can take', () => {
  const cases: readonly [string, string][] = [
    [`import { A } from 'x1';`, 'x1'],
    [`import { A } from "x2";`, 'x2'],
    [`import type { A } from "x3";`, 'x3'],
    [`import A from "x4";`, 'x4'],
    [`import * as A from "x5";`, 'x5'],
    [`import "x6";`, 'x6'],
    [`const A = await import("x7");`, 'x7'],
    [`export { A } from "x8";`, 'x8'],
    [`export * from "x9";`, 'x9'],
    [`import {\n  A,\n  B,\n} from "x10";`, 'x10'],
  ];

  for (const [source, expected] of cases) {
    it(`finds ${expected} in ${JSON.stringify(source)}`, () => {
      expect(specifiersOf(source)).toContain(expected);
    });
  }
});

describe('the closed value sets are leaves', () => {
  const schemaFiles = trackedSources('src/db/schema');
  const domainFiles = trackedSources('src/domain');

  it('scans a non-empty set of files in both directories', () => {
    // The vacuity floor. `expect([]).toEqual([])` is what a BROKEN scan produces,
    // and it is indistinguishable from a clean tree without this.
    expect(schemaFiles.length).toBeGreaterThanOrEqual(15);
    expect(domainFiles.length).toBeGreaterThanOrEqual(20);
  });

  it('finds imports at all, so an empty result means absence rather than a broken pattern', () => {
    // A positive control on the SCANNER: `db/schema` demonstrably imports things
    // (drizzle, @oxy.so/db). If this is empty the pattern is broken and every
    // assertion below passes while measuring nothing.
    const seen = schemaFiles.flatMap((f) => specifiersOf(f.text));
    expect(seen.length).toBeGreaterThanOrEqual(30);
    expect(seen).toContain('drizzle-orm/pg-core');
  });

  it('every domain module is a leaf — it imports nothing', () => {
    const offenders = domainFiles.flatMap(({ file, text }) =>
      specifiersOf(text).map((spec) => `${file} imports '${spec}'`),
    );
    expect(offenders).toEqual([]);
  });
});
