import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

/**
 * `.populate()` on a ref this service does not own is a 500 waiting for traffic.
 *
 * Several schemas declare `ref: 'User'` (and one `ref: 'Folder'`). No such model
 * is registered here and none ever will be: Oxy owns identity, and a local users
 * collection would be a cache free to disagree with it. Mongoose answers a
 * populate on such a path with `MissingSchemaError` — but ONLY once there is at
 * least one document to populate. On an empty result set it never resolves the
 * ref and the query succeeds.
 *
 * That asymmetry is the whole problem. Three endpoints shipped this way and
 * worked in every smoke test, because a fresh organization has no members and a
 * new agent has no reviews; they returned 500 the moment somebody used the
 * feature. `git log` for the fix has the measurements.
 *
 * So this gate does NOT forbid the declaration — a dangling `ref` is inert, and
 * removing all 41 of them is churn each port batch will do anyway. It forbids
 * the ACT that turns one into an outage, which is also the thing a future author
 * would reach for innocently.
 *
 * Read `lib/oxy-user-hydration.ts` for what to do instead.
 */

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * Refs naming a model this service deliberately does not register.
 *
 * This is not a list of things to fix later — it is a statement about ownership,
 * and it is expected to stay non-empty. Adding to it is a decision that some
 * other service owns that entity, which is why each member carries its owner.
 */
const FOREIGN_REFS: Readonly<Record<string, string>> = {
  User: 'Oxy owns identity; resolve through lib/oxy-user-hydration.ts.',
  Folder: 'No Folder model exists in this service; Conversation.folderId is a bare id.',
};

/** Every model file, so importing them registers every schema. */
function modelFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files', 'src'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  // An affirmative filter: model definitions live in these two directories, and
  // a new one has to be added here on purpose rather than silently uncovered.
  return tracked.filter(
    (f) =>
      /\.ts$/.test(f) &&
      !/__tests__|\.test\.ts$/.test(f) &&
      (f.startsWith('src/models/') || f.startsWith('src/internal/providers/models/')),
  );
}

const files = modelFiles();

/**
 * Vacuity guard, in TWO parts, and neither is redundant beside the other.
 *
 * An empty or broken traversal produces the same "no violations" result as a
 * clean tree, so what the scan found is asserted rather than assumed.
 *
 * **The EQUALITY** (`modelNames().length === files.length`) is structural. It
 * catches a file that registers two models or none — the case that makes the
 * enumeration below stop covering what the directory holds — by comparing the
 * scan against ITSELF. It needs no maintenance and stays true however many
 * models remain.
 *
 * **The CONSERVED TOTAL** is the only part that catches a BROKEN SCAN. The
 * equality is vacuously true at zero: `0 === 0` is what a wrong glob, a moved
 * directory and a traversal that read nothing all report, identically.
 *
 * ## The total is conserved because a FLOOR could not be
 *
 * This was `files.length >= 40`, and a floor whose input the migration deletes
 * erodes to vacuity one defensible step at a time. It went 60 -> 40 already;
 * every slice makes it fail, the cheapest fix is always to decrement, and the
 * terminus is `>= 0`, a check that cannot fail. The floor was correct when
 * written and was being eroded by the work it protects — measured on
 * `55754587`, it had THREE files of headroom against four slices queued to
 * delete more than fifteen.
 *
 * So the invariant is a SUM that does not move: every model file this service
 * ever had is either still present or recorded in `RETIRED_MODEL_FILES`.
 * Deleting a model without recording it drops the sum; recording one without
 * deleting it raises the sum; deleting a RECORD drops the sum. All three are
 * red, which is the property a floor never had — a floor cannot tell "we
 * deleted a model" from "the scan broke", and it goes quiet when the list it
 * relies on shrinks.
 *
 * It also closes a hole the floor-plus-equality pair documented and could not
 * cover: a MID-RANGE truncation of the file list. Measured previously,
 * `.slice(0, 45)` left both green (45 === 45, and 45 >= 40); against a conserved
 * total it is `45 + 0 !== 43` and red.
 *
 * ## Its retirement condition, because it HAS one
 *
 * When the port deletes the last model, `files.length` reaches 0 and every
 * assertion here is satisfied only by a `RETIRED_MODEL_FILES` naming all 43.
 * That is not the moment to relax anything — it is the moment this WHOLE FILE
 * goes, along with Mongoose, at S10. Nothing below should be weakened to keep
 * it alive past that point.
 */

/** A model file the Postgres port has deleted, and who deleted it. */
interface RetiredModelFile {
  /** The Mongoose model it registered, e.g. `Trigger`. */
  readonly model: string;
  /** Its path, exactly as `modelFiles()` would have listed it. */
  readonly file: string;
  /** The slice that retired it, so the sum is auditable against git history. */
  readonly retiredBy: string;
}

/**
 * Empty on purpose.
 *
 * No slice has landed a model deletion yet — S3, S4, S8 and S9 are each holding
 * theirs for a follow-up PR that rebases onto this file. Each adds its own
 * entries in the SAME commit that deletes the files, which is the whole point:
 * a deletion is recorded rather than absorbed.
 */
const RETIRED_MODEL_FILES: readonly RetiredModelFile[] = [];

/**
 * Live model files plus retired ones. Counted on `55754587`, where 43 were
 * present and none had been retired.
 *
 * This number moves ONLY when this service gains a genuinely new Mongoose model,
 * which the port makes vanishingly unlikely — and never to accommodate a
 * deletion, which is what `RETIRED_MODEL_FILES` absorbs.
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
 * The distinction is the point. `tsc` already refuses a static import of a
 * deleted module, so that failure needs no gate. What nothing catches is a
 * reference held as a STRING: `vi.mock('../../models/trigger.js', …)` is a
 * plain argument neither the compiler nor vitest resolves, so deleting the
 * module leaves the mock silently stubbing nothing. One was found live in
 * `lib/__tests__/trigger-engine.test.ts` during S8. A dynamic
 * `import('../models/trigger.js')` and a stale comment have the same shape.
 *
 * So TEST FILES ARE SCANNED — excluding them would skip the only place the
 * hazard has actually occurred. Read with `readFileSync` rather than `grep`,
 * which is line-based and reports a clean zero for any pattern that could span
 * a newline.
 */
function filesReferencing(file: string, sources: string[]): string[] {
  const specifier = specifierOf(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A specifier is always followed by an extension or the closing quote, which
  // is what stops `models/trigger` matching `models/trigger-execution`.
  const pattern = new RegExp(`${specifier}(\\.js|\\.ts|['"\`])`);
  return sources.filter((source) =>
    readFileSync(path.join(PACKAGE_ROOT, source), 'utf8')
      .split('\n')
      .some((line) => pattern.test(line)),
  );
}

/** Every tracked TypeScript source, TESTS INCLUDED. See `filesReferencing`. */
function allSources(): string[] {
  return execFileSync('git', ['ls-files', 'src'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.ts$/.test(f));
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

await Promise.all(
  files.map((f) => import(path.join(PACKAGE_ROOT, f.replace(/\.ts$/, '.js')))),
);

/** Every `(model, path, ref)` triple across every registered schema. */
function declaredRefs(): { model: string; path: string; ref: string }[] {
  const found: { model: string; path: string; ref: string }[] = [];
  for (const name of mongoose.modelNames()) {
    mongoose.model(name).schema.eachPath((pathName: string, schemaType: mongoose.SchemaType) => {
      const options = schemaType.options as { ref?: unknown } | undefined;
      // Array paths carry the ref on the element caster instead.
      const caster = (schemaType as { caster?: { options?: { ref?: unknown } } }).caster;
      const ref = options?.ref ?? caster?.options?.ref;
      if (typeof ref === 'string') found.push({ model: name, path: pathName, ref });
    });
  }
  return found;
}

describe('populating a ref this service does not own', () => {
  it('registered exactly one model per model file, and scanned a real tree', () => {
    /**
     * Structural: a file registering two models, or none, means the enumeration
     * below no longer covers what the directory holds.
     */
    expect(mongoose.modelNames().length).toBe(files.length);
    /**
     * The positive control on the OUTPUT, and the part that catches a BROKEN
     * SCAN — the equality above passes at zero. See `MODEL_FILES_EVER` for why
     * this is a conserved sum and not the floor it replaced.
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

  it('every retired entry names a file that is GONE and a model that is UNREGISTERED', () => {
    /**
     * The mirror of `RETIRED_MONGO_TTLS`'s "every retired entry names a table
     * that EXISTS". Without it a typo'd or premature entry props the sum up
     * while asserting nothing — and an entry added BEFORE its file is deleted
     * would silently buy headroom, which is the erosion this replaces.
     */
    const stillPresent = RETIRED_MODEL_FILES.filter((r) => files.includes(r.file));
    expect(stillPresent).toEqual([]);

    const stillRegistered = RETIRED_MODEL_FILES.filter((r) =>
      mongoose.modelNames().includes(r.model),
    );
    expect(stillRegistered).toEqual([]);
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
     * existed and is named by `SCANNER_CONTROL_SPECIFIER` two hundred lines up.
     * If this finds nothing, the assertion below is measuring nothing either.
     */
    expect(filesReferencing(SCANNER_CONTROL_FILE, sources).length).toBeGreaterThan(0);
    expect(SCANNER_CONTROL_SPECIFIER).toContain('__scanner_control__');

    /**
     * THIS file necessarily names every retired path — recording them is its
     * job — so it is the one exclusion, and it is one line rather than a
     * category. The hazard lives in OTHER test files: a `vi.mock` specifier is
     * a string neither tsc nor vitest resolves.
     */
    const scanned = sources.filter((f) => !f.endsWith('foreign-ref-populate.test.ts'));
    const dangling = RETIRED_MODEL_FILES.flatMap((retired) =>
      filesReferencing(retired.file, scanned).map((source) => `${source} -> ${retired.file}`),
    );
    expect(dangling).toEqual([]);
  });

  it('every declared ref is either registered here or a named foreign owner', () => {
    const unexplained = declaredRefs().filter(
      ({ ref }) => !mongoose.modelNames().includes(ref) && !(ref in FOREIGN_REFS),
    );

    // A ref naming neither a local model nor a documented foreign owner is a
    // typo or a deletion nobody finished — both produce the same runtime throw.
    expect(unexplained).toEqual([]);
  });

  it('no source file populates a path bound to a foreign ref', () => {
    const foreignPaths = new Set(
      declaredRefs()
        .filter(({ ref }) => ref in FOREIGN_REFS)
        .map(({ path: p }) => p),
    );
    // The gate is only meaningful if there is something foreign to protect.
    expect(foreignPaths.size).toBeGreaterThan(0);

    const sources = execFileSync('git', ['ls-files', 'src'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => /\.ts$/.test(f) && !/__tests__|\.test\.ts$/.test(f));

    const violations: string[] = [];
    for (const file of sources) {
      const text = readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
      text.split('\n').forEach((line, index) => {
        for (const foreign of foreignPaths) {
          // Match the populate CALL, not a mention: `.populate('userId'` with
          // either quote style. The whole line is reported, so a reader is never
          // shown a truncated capture group they have to trust.
          if (new RegExp(`\\.populate\\(\\s*['"\`]${foreign}['"\`]`).test(line)) {
            violations.push(`${file}:${index + 1}  ${line.trim()}`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
