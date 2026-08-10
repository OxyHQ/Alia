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
 * Vacuity floor. An empty or broken traversal produces the same "no violations"
 * result as a clean tree, so the count is asserted rather than assumed.
 *
 * ## This floor legitimately FALLS as the Postgres port proceeds, and the TTL
 * gate's floor does not — the difference is what each one measures
 *
 * `ttlRegistryCoverage.test.ts` counts TTL DECLARATIONS as a proxy for sweep
 * COVERAGE, so lowering it drops a guarantee and its declarations are moved to a
 * retired list instead, keeping the total conserved. This number measures the
 * TRAVERSAL — whether `git ls-files` still finds the model tree — and the models
 * it counts are genuinely being deleted. Lowering it loses nothing; leaving it
 * would fail on a correct change.
 *
 * 56 on 748e620b, 48 after S5 deletes its seven. Set below the live count with
 * headroom because sibling slices are deleting models concurrently, and well
 * above what a broken walk reports, which is zero or single digits. Re-express
 * or delete this at S10, when there are no models left to walk.
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
  it('scanned enough model files to be meaningful', () => {
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_MODEL_FILES);
    expect(mongoose.modelNames().length).toBeGreaterThanOrEqual(MINIMUM_MODEL_FILES);
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
