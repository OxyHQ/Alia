import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Postgres schema must not import a Mongoose model — at all, and especially
 * not as a RUNTIME value.
 *
 * Every closed value set in this schema renders a CHECK constraint, and until
 * this gate existed those tuples were `export const`s on the Mongoose models, so
 * `db/schema` imported `src/models/` at module-evaluation time. That made the
 * SCHEMA — and therefore every migration's CHECK — depend on a model directory
 * the port exists to delete. Deleting a model would not merely break a type: it
 * would stop `db/schema/index.ts` loading, which is a failure `drizzle-kit`
 * reports by generating NOTHING while exiting 0.
 *
 * The tuples now live in `src/domain/`, read by BOTH stores — the model's
 * `enum` validator and the CHECK — so the single-tuple rule in
 * `CONVENTIONS.md` ("Closed value sets") survives the models' removal.
 *
 * ## Why a test rather than a convention
 *
 * The regression is one `import` line in a new schema file, it typechecks, and
 * every suite stays green: the schema still loads, because the models still
 * exist. The dependency only bites on the day somebody deletes them, in a
 * different PR, as a failure that names the deleter rather than the author. This
 * is the one moment the rule is cheap to enforce.
 *
 * ## Both directions, because only one is obvious
 *
 * A `db/schema` file importing a model is the regression this exists for. A
 * `domain` module importing ANYTHING is the subtler one: the whole point of
 * that directory is that it is a leaf, so a value set that reaches back into a
 * model (for an interface, say) re-creates the dependency through one more hop
 * and reads as harmless in review.
 */

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * `git ls-files` rather than a directory walk: it reports the INDEX, so it
 * cannot disagree with what git tracks and excludes build output for free.
 *
 * A file named in the index but absent from the working tree throws here rather
 * than being skipped — an unread file is exactly where a reintroduced import
 * would hide.
 */
function trackedSources(prefix: string): { file: string; text: string }[] {
  return execFileSync('git', ['ls-files', '--', prefix], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts'))
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

/** Resolve a relative specifier to a package-relative path with no extension. */
function resolve(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(path.join(PACKAGE_ROOT, fromFile)), spec);
  return path.relative(PACKAGE_ROOT, abs).replace(/\.(js|ts)$/, '');
}

/** Matches BOTH model directories. `src/internal/providers/models/` is the one a single-path check misses. */
const MODEL_DIR = /(^|\/)models\//;

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

describe('the Postgres schema does not depend on the Mongoose models', () => {
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
    // (drizzle, @oxyhq/db). If this is empty the pattern is broken and every
    // assertion below passes while measuring nothing.
    const seen = schemaFiles.flatMap((f) => specifiersOf(f.text));
    expect(seen.length).toBeGreaterThanOrEqual(30);
    expect(seen).toContain('drizzle-orm/pg-core');
  });

  it('no db/schema module imports from a Mongoose model directory', () => {
    const offenders = schemaFiles.flatMap(({ file, text }) =>
      specifiersOf(text)
        .map((spec) => ({ spec, resolved: resolve(file, spec) }))
        .filter(({ resolved }) => resolved !== null && MODEL_DIR.test(resolved))
        .map(({ spec }) => `${file} imports '${spec}'`),
    );
    expect(offenders).toEqual([]);
  });

  it('every domain module is a leaf — it imports nothing', () => {
    const offenders = domainFiles.flatMap(({ file, text }) =>
      specifiersOf(text).map((spec) => `${file} imports '${spec}'`),
    );
    expect(offenders).toEqual([]);
  });

  it('no Mongoose model re-exports a value set', () => {
    // The clean cut. A re-export would let every existing consumer keep
    // compiling, which is precisely what makes the dependency survive a review
    // that only reads the schema.
    const offenders = trackedSources('src/models')
      .concat(trackedSources('src/internal/providers/models'))
      .flatMap(({ file, text }) =>
        [...text.matchAll(/(?:^|\n)\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g)].map(
          (m) => `${file} re-exports from '${m[1]}'`,
        ),
      );
    expect(offenders).toEqual([]);
  });
});
