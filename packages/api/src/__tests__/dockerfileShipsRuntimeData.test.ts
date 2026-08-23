/**
 * The runtime image must contain the FILES THE CODE READS BY PATH.
 *
 * ## The defect
 *
 * The runtime stage copied `packages/api/dist` and nothing else, while
 * `migrate.js` resolves `join(PACKAGE_ROOT, 'drizzle')` at runtime. So the
 * migrator started and immediately died with
 *
 *   Cannot read the migration journal at
 *   /app/packages/api/drizzle/meta/_journal.json: ENOENT
 *
 * A bundler cannot rescue this: the `.sql` files and `_journal.json` are DATA
 * read by path, not modules imported, so `build.ts` will never inline them
 * however the entrypoint is written. The Dockerfile is the only place that can
 * put them in the image, which is why the assertion lives here rather than
 * beside the build.
 *
 * ## Why it stayed hidden until now
 *
 * It sat one layer BELOW the `__dirname` defect. The migrator never got as far
 * as reading the journal, so the missing directory could not announce itself —
 * fixing the first bug is what exposed the second. Both were found the same
 * way, by running the real artefact in the real image, and neither is visible
 * to `tsc`, to the test suites, or to a successful `docker build`.
 *
 * ## What this test can and cannot prove
 *
 * It reads the Dockerfile rather than building an image, so it proves the COPY
 * is DECLARED, not that a built image contains the files. That is the honest
 * limit and it is stated rather than papered over: the end-to-end proof is a
 * migration task against a real database, which is an operator action rather
 * than something CI can run. What this catches is the regression — somebody
 * removing or renaming the copy — which is the realistic failure now that the
 * line exists.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ALIA_MODELS } from '../internal/providers/lib/alia-models.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const dockerfile = readFileSync(`${packageRoot}Dockerfile`, 'utf8');

/**
 * Every path the runtime stage copies out of the builder, as the destination
 * directory under `/app/packages/api/`. Parsed rather than grepped for a fixed
 * string so a rename shows up as an absence rather than as a still-passing
 * match on a line that has moved.
 */
const copiedIntoPackage = [
  ...dockerfile.matchAll(/^COPY --from=builder \S+ \.\/packages\/api\/(\S+)$/gm),
].map((m) => m[1].replace(/\/$/, ''));

describe('the runtime image ships what the code reads by path', () => {
  /**
   * Vacuity floor. Every assertion below is a membership test against
   * `copiedIntoPackage`, and a parse that matched nothing would fail them all
   * for the wrong reason — an empty list is what a CHANGED Dockerfile syntax
   * produces, not what a broken image produces. Pin the parse itself against a
   * landmark that must always be there.
   */
  it('parsed the runtime stage rather than matching nothing', () => {
    expect(dockerfile.length).toBeGreaterThan(1000);
    expect(copiedIntoPackage.length).toBeGreaterThanOrEqual(2);
    expect(copiedIntoPackage).toContain('dist');
  });

  it('copies the migrations directory into the image', () => {
    expect(copiedIntoPackage).toContain('drizzle');
  });

  /**
   * The two halves of one fact. The Dockerfile copies a directory NAMED
   * `drizzle`; the migrator reads a directory named by `drizzle.config.ts` and
   * by `migrate.ts`'s own `join(PACKAGE_ROOT, …)`. Renaming one without the
   * other produces exactly the ENOENT this test exists to prevent, and nothing
   * else in the repo relates them.
   */
  it('copies the same directory name the migrator resolves at runtime', () => {
    const migrateSource = readFileSync(`${packageRoot}src/db/migrate.ts`, 'utf8');
    expect(migrateSource).toContain("join(PACKAGE_ROOT, 'drizzle')");
    expect(existsSync(`${packageRoot}drizzle/meta/_journal.json`)).toBe(true);
  });

  /**
   * The same defect, found in production on 2026-08-23 while tracing something
   * else. `lib/prompt-loader.ts` resolves `join(__dirname, '../prompts', name)`
   * and the runtime stage did not copy that directory, so every request logged
   *
   *   Error loading prompt  ENOENT: ... '/app/packages/api/prompts/alia-lite.md'
   *   Error loading prompt  ENOENT: ... '/app/packages/api/prompts/base.md'
   *
   * and `loadPrompt` RETURNS '' on failure. Alia therefore served every request
   * with no system prompt: degraded, never broken, and invisible to any check
   * that asks only whether a request succeeded. It is exactly what the drizzle
   * copy above was added for, one directory over, and it was missed because the
   * gate named only migrations.
   */
  it('copies the prompts directory into the image', () => {
    expect(copiedIntoPackage).toContain('prompts');
  });

  /**
   * The two halves of one fact, as above: the Dockerfile copies a directory
   * NAMED `prompts`, and the loader resolves a directory named in its own
   * source. Renaming either alone reproduces the ENOENT silently.
   */
  it('copies the same directory name the loader resolves at runtime', () => {
    const loaderSource = readFileSync(`${packageRoot}src/lib/prompt-loader.ts`, 'utf8');
    expect(loaderSource).toContain("'../prompts'");
    expect(existsSync(`${packageRoot}prompts/base.md`)).toBe(true);
  });

  /**
   * And that the directory is not merely PRESENT but populated with the names
   * the code asks for. `buildSystemPrompt` loads `prompts/<modelId>.md`, so the
   * alias id IS the filename — a rename of an id that forgets the file degrades
   * to an empty prompt rather than to an error.
   *
   * Read from `ALIA_MODELS` rather than from a list written here, or the check
   * measures a copy of the answer instead of the answer.
   */
  it('ships a prompt for every alias the builder will ask for', () => {
    const ids = Object.keys(ALIA_MODELS);
    const missing = ids.filter((id) => !existsSync(`${packageRoot}prompts/${id}.md`));
    expect(missing).toEqual([]);
    // Vacuity floor: an empty ALIA_MODELS satisfies the line above.
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });
});
