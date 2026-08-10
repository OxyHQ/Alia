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
 * clean tree, so what the scan found is asserted rather than assumed. The two
 * assertions catch different failures:
 *
 * **The EQUALITY** (`modelNames().length === files.length`) is structural. It
 * catches a file that registers two models or none — the case that makes the
 * enumeration below stop covering what the directory holds — by comparing the
 * scan against ITSELF. It needs no maintenance, stays true however many models
 * remain, and a sibling slice merging cannot break it.
 *
 * **The FLOOR** is the only part that catches a BROKEN SCAN. The equality is
 * vacuously true at zero: `0 === 0` is what a wrong glob, a moved directory, a
 * traversal that read nothing and a fully-deleted model tree all report,
 * identically. A positive control on the OUTPUT is what tells those apart from
 * a clean run, and that is a number.
 *
 * Both were mutation-tested, and each survives what the other kills:
 *
 * - filter typo'd to `src/modelz/` — the floor fails `expected 0 to be greater
 *   than or equal to 40`, and **the equality passes**, because `0 === 0`.
 * - `src/domain/` folded into the filter, so 23 files register no model — the
 *   equality fails `expected 51 to be 74`, and **the floor passes**, 74 >= 40.
 *
 * Neither half catches a MID-RANGE truncation (measured: `.slice(0, 45)` leaves
 * both green, 45 === 45 and 45 >= 40). That case is caught downstream instead,
 * by the unexplained-ref assertion below — a truncated import leaves a ref
 * naming a model that is no longer registered. Stated rather than papered over,
 * because a third assertion here would duplicate coverage that already exists.
 *
 * ## Why the floor is 40 and not the live count
 *
 * Its input is the number of Mongoose model files, which the Postgres port
 * deletes, so it only ever moves down — 60 until #123 set it to 40. Worse, the
 * failure lands on a MERGE rather than on either branch: S1 removed three
 * models, #121 one, #123 seven and S6 two, and no single diff contains the sum,
 * so a branch's green CI goes stale the moment a sibling merges. Set well below
 * the live count (measured: 53 on `a3aa0ed4`, 51 once S6 deletes its two) and
 * well above what a broken walk reports, which is zero or single digits. That
 * headroom is what keeps it from being decremented one defensible step at a
 * time toward `>= 0`, a check that cannot fail.
 *
 * ## Its retirement condition, because it HAS one
 *
 * When the port deletes the last model the floor becomes unsatisfiable, and a
 * control that cannot be satisfied is a permanent red rather than a gate. That
 * is not the moment to lower it — it is the moment this WHOLE FILE goes, along
 * with Mongoose, at S10. There is no valid state in which this file exists and
 * the floor is below single digits.
 */
const MINIMUM_MODEL_FILES = 40;

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
     * The positive control on the OUTPUT. Deliberately NOT folded into the
     * equality above and NOT written as `> 0`: the equality passes at zero, and
     * a broken walk reports zero or single digits. See the floor's comment for
     * why the number is 40 and for the condition that retires this whole file
     * rather than lowering it.
     */
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_MODEL_FILES);
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
