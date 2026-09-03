import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_MODEL_FILES } from './retiredModelFiles';

/**
 * The integrity of the retired-model ledger, and the one hazard a deletion
 * leaves behind that `tsc` cannot see.
 *
 * ## What this file used to be
 *
 * It was `foreign-ref-populate.test.ts`, and its subject was `.populate()` on a
 * Mongoose `ref` this service does not own — three endpoints shipped that way,
 * passed every smoke test because a fresh organization has no members, and
 * returned 500 the moment somebody used the feature. That gate walked the
 * registered schemas for `ref:` declarations.
 *
 * There are none. `packages/api` registers no Mongoose model and can register
 * none: `db/__tests__/bootWiring.test.ts` freezes the set of files in this
 * package that import the driver at exactly one, an operator one-shot that
 * nothing imports. So the ref walk, the foreign-owner list and the populate scan
 * were deleted rather than inverted — a scan over a set that is empty by
 * construction reports "no violations" for the same reason a scan that read
 * nothing does, and cannot be made to tell them apart. The gate that goes red the
 * day a model returns is the importer freeze, which is stronger: it catches a
 * model declared anywhere, not only one under `src/models/` that happens to
 * declare a `ref`.
 *
 * ## What survives, and why each part does
 *
 * `RETIRED_MODEL_FILES` outlived its original gate. It is the ledger of the 43
 * model files the Postgres port deleted, and `uniqueConstraintParity.pgdb.test.ts`
 * reads it against a migrated server to prove no model left with its uniqueness
 * unrecorded. A ledger that props up a live assertion needs its own integrity
 * checked, which is the first half of this file.
 *
 * The second half is the deletion hazard itself, and it is not Mongo-shaped.
 * `tsc` refuses a static import of a deleted module, so that failure needs no
 * gate. What nothing catches is a reference held as a STRING:
 * `vi.mock('../../models/trigger.js', …)` is a plain argument neither the
 * compiler nor vitest resolves, so deleting the module leaves the mock silently
 * stubbing nothing. One was found live in `lib/__tests__/trigger-engine.test.ts`
 * during S8. A dynamic `import('../models/trigger.js')` and a stale comment have
 * the same shape.
 */

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * Every model file still present.
 *
 * An affirmative filter: model definitions lived in these two directories, and a
 * new one would have to be added here on purpose rather than silently uncovered.
 * It returns nothing today, and the conserved total below is what makes that a
 * measurement rather than an assumption.
 */
function modelFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files', 'src'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => Boolean(file) && existsSync(path.join(PACKAGE_ROOT, file)));
  return tracked.filter(
    (f) =>
      /\.ts$/.test(f) &&
      !/__tests__|\.test\.ts$/.test(f) &&
      (f.startsWith('src/models/') || f.startsWith('src/internal/providers/models/')),
  );
}

const files = modelFiles();

/**
 * Live model files plus retired ones. Counted on `55754587`, where 43 were
 * present and none had been retired.
 *
 * ## The total is conserved because a FLOOR could not be
 *
 * This was `files.length >= 40`, and a floor whose input the migration deletes
 * erodes to vacuity one defensible step at a time. It went 60 -> 40 already;
 * every slice made it fail, the cheapest fix was always to decrement, and the
 * terminus is `>= 0`, a check that cannot fail. The floor was correct when
 * written and was being eroded by the work it protects — measured on
 * `55754587`, it had THREE files of headroom against four slices queued to
 * delete more than fifteen.
 *
 * So the invariant is a SUM that does not move: every model file this service
 * ever had is either still present or recorded in `RETIRED_MODEL_FILES`.
 * Deleting a model without recording it drops the sum; recording one without
 * deleting it raises the sum; deleting a RECORD drops the sum. All three are
 * red, which is the property a floor never had — a floor cannot tell "we deleted
 * a model" from "the scan broke", and it goes quiet when the list it relies on
 * shrinks. It also closes a hole the floor could not cover: a MID-RANGE
 * truncation of the file list. Measured previously, `.slice(0, 45)` left a floor
 * of 40 and an equality both green; against a conserved total it is red.
 *
 * `files.length` is 0 and `RETIRED_MODEL_FILES.length` is 43, so the sum is now
 * carried entirely by the ledger — which is precisely why the ledger's own
 * integrity is asserted below rather than assumed. The number moves only if this
 * service gains a genuinely new model file, and never to accommodate a deletion.
 */
const MODEL_FILES_EVER = 43;

/**
 * A retired file's module specifier, as an importer would spell it.
 *
 * `src/models/trigger.ts` and `src/internal/providers/models/plan.ts` are both
 * reached by RELATIVE paths ending `models/trigger` and `models/plan`, so the
 * trailing two segments are what a reference actually contains. Two files with
 * the same basename in the two model directories would over-match; that is the
 * safe direction, because a false positive blocks a deletion until somebody
 * looks, while a false negative ships a dangling reference.
 */
function specifierOf(file: string): string {
  return file.replace(/\.ts$/, '').split('/').slice(-2).join('/');
}

/**
 * Files whose TEXT still names `file` — not files that import it.
 *
 * TEST FILES ARE SCANNED, because excluding them would skip the only place the
 * hazard has actually occurred. Read with `readFileSync` rather than `grep`,
 * which is line-based and reports a clean zero for any pattern that could span a
 * newline.
 */
function filesReferencing(file: string, sources: string[]): string[] {
  const specifier = specifierOf(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /**
   * A RELATIVE prefix is required, and it is what separates a reference from a
   * CITATION.
   *
   * Every module specifier in this package is relative — `../models/trigger.js`,
   * `../../models/trigger.js` — while prose naming a deleted file is
   * repo-rooted, e.g. ``read off `src/models/trigger-execution.ts:86` before it
   * was deleted``. `db/__tests__/ttlRegistryCoverage.test.ts` writes exactly
   * that, deliberately, as the provenance for a TTL whose source no longer
   * exists, and the first real use of this gate flagged it.
   *
   * That citation is CORRECT and must stay: it is the only surviving record of
   * what the index said. A gate cannot tell a valuable citation from a stale
   * comment, so it does not try — it polices what the runtime resolves. The
   * trailing extension-or-quote is what stops `models/trigger` matching
   * `models/trigger-execution`.
   */
  const pattern = new RegExp(`\\.\\.?/${specifier}(\\.js|\\.ts|['"\`])`);
  return sources.filter((source) =>
    readFileSync(path.join(PACKAGE_ROOT, source), 'utf8')
      .split('\n')
      .filter((line) => !isCommentLine(line))
      .some((line) => pattern.test(line)),
  );
}

/**
 * A line that is entirely comment, and therefore not a reference.
 *
 * This is what lets the scan cover EVERY file including this one. A relative
 * specifier written as documentation always sits on a comment line — this file's
 * own docblock spells out `vi.mock('../../models/trigger.js', …)` to explain the
 * hazard — while a real call never does. Matching on the line's first
 * non-whitespace character rather than stripping `//` anywhere keeps a `https://`
 * inside a string intact.
 *
 * A commented-out `vi.mock` is deliberately not a finding: it resolves nothing.
 */
function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

/** Every tracked TypeScript source, TESTS INCLUDED. See `filesReferencing`. */
function allSources(): string[] {
  return execFileSync('git', ['ls-files', 'src'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.ts$/.test(f) && existsSync(path.join(PACKAGE_ROOT, f)));
}

/**
 * A file that never existed, referenced by the line below purely so the scanner
 * has a known-positive to find.
 *
 * The control runs the SAME `filesReferencing` over the SAME `allSources()` as
 * the real assertion, so it fails for the same reasons: a broken `git ls-files`,
 * an unreadable tree, a regex that matches nothing. "No reader of a retired
 * model remains" is also what a scan that read zero files reports, and this is
 * what tells those two apart.
 *
 * It has no shelf life, because it names no production code — the reference it
 * finds is this file's own.
 */
const SCANNER_CONTROL_FILE = 'src/models/__scanner_control__.ts';
const SCANNER_CONTROL_SPECIFIER = '../models/__scanner_control__.js';

describe('the retired-model ledger', () => {
  it('accounts for every model file this service ever had', () => {
    /**
     * The conserved sum. See `MODEL_FILES_EVER` for why it is a sum and not the
     * floor it replaced, and why it is the ratchet that catches a model file
     * reappearing under either model directory.
     */
    expect(files.length + RETIRED_MODEL_FILES.length).toBe(MODEL_FILES_EVER);
  });

  it('records each retired model exactly once', () => {
    /**
     * Without this, one entry repeated props the sum up while a second deletion
     * goes unrecorded — the sum stays 43 and the gate reports clean.
     */
    const byFile = RETIRED_MODEL_FILES.map((r) => r.file);
    expect(new Set(byFile).size).toBe(byFile.length);
    const byModel = RETIRED_MODEL_FILES.map((r) => r.model);
    expect(new Set(byModel).size).toBe(byModel.length);
    // Every entry says who retired it, so the sum is auditable against history.
    expect(RETIRED_MODEL_FILES.filter((r) => r.retiredBy.trim() === '')).toEqual([]);
  });

  it('every retired entry names a file that is GONE', () => {
    /**
     * The mirror of `ttlRegistryCoverage`'s "every declaration names a table that
     * EXISTS". Without it a typo'd or premature entry props the sum up while
     * asserting nothing — and an entry added BEFORE its file is deleted would
     * silently buy headroom, which is the erosion the conserved sum replaces.
     */
    expect(RETIRED_MODEL_FILES.filter((r) => files.includes(r.file))).toEqual([]);
  });

  it('nothing still names a retired model file, and the scanner can see a reference', () => {
    const sources = allSources();
    /**
     * Vacuity floor on the INPUT: a broken `git ls-files`, a wrong cwd or an
     * empty checkout all report "no references" identically to a clean tree.
     */
    expect(sources.length).toBeGreaterThan(500);

    /**
     * Vacuity floor on the OUTPUT, in the same currency as the measurement: the
     * same `filesReferencing` over the same `sources`, for a path that never
     * existed and is named by `SCANNER_CONTROL_SPECIFIER` above. If this finds
     * nothing, the assertion below is measuring nothing either.
     */
    expect(filesReferencing(SCANNER_CONTROL_FILE, sources).length).toBeGreaterThan(0);
    expect(SCANNER_CONTROL_SPECIFIER).toContain('__scanner_control__');

    /**
     * NO file is exempt, including this one.
     *
     * It used to be, because recording retired paths is this file's job and its
     * docblocks quote relative specifiers verbatim. But a blanket exemption is
     * the shape that grows one defensible line at a time, and it left a real
     * hole: a `vi.mock` of a retired model placed HERE — the file that talks
     * about mocks, and therefore the likely place somebody adds one — went
     * uncaught. Skipping comment LINES instead of whole FILES removes the
     * exemption entirely rather than narrowing it, so there is no list of
     * exemptions to keep an exact count of.
     *
     * `RETIRED_MODEL_FILES`'s own `file:` values are repo-rooted, so the
     * relative-prefix rule already excludes them without naming them.
     */
    const dangling = RETIRED_MODEL_FILES.flatMap((retired) =>
      filesReferencing(retired.file, sources).map((source) => `${source} -> ${retired.file}`),
    );
    expect(dangling).toEqual([]);
  });
});
