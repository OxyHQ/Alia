/**
 * The deploy workflow's migration wiring, gated.
 *
 * ## Why this file exists at all
 *
 * `deploy-ecs-image.sh` has carried complete migration support since it was
 * written — `RUN_MIGRATIONS`, `MIGRATION_PHASE`, `MIGRATION_TARGET_DATABASE`, a
 * one-shot task on the NEW task definition, CloudWatch logs on failure. Nothing
 * ever set `RUN_MIGRATIONS`, so for the whole life of this service **nothing
 * applied its migrations, in any environment**, and the deploy was green
 * throughout. That is the failure mode this file guards: not a broken step, an
 * ABSENT one, which looks exactly like a working deploy.
 *
 * A workflow is not covered by `tsc`, `eslint` or any other gate in this repo,
 * so an assertion here is the only thing that can notice the wiring going away
 * again.
 *
 * ## What each assertion is actually for
 *
 * The grep-pattern check is the load-bearing one, and it is a DRIFT gate rather
 * than a correctness one: the workflow decides whether to run the `post` phase
 * by grepping the migration files, and if that pattern and the marker the
 * migrator writes ever disagree, the workflow reads "no post migration" and the
 * drop is applied by nothing at all. Silently. So the pattern is compared
 * against the constant `@oxyhq/db` EXPORTS rather than a copy retyped here —
 * a copy would drift in exactly the case it is meant to catch.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// `@oxyhq/db/migrate`, not the root entry — the root export map does not
// re-export the migrate subpath, so importing it from there yields `undefined`
// and every substring assertion below would then compare against nothing. That
// is not hypothetical: it is what this file did on its first run, and the
// literal comparison in the drift test is what caught it rather than a
// mysteriously passing `toContain`.
import { POST_PHASE_GREP_PATTERN } from '@oxyhq/db/migrate';

const workflowPath = fileURLToPath(new URL('../../../../../.github/workflows/deploy-aws.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');

describe('deploy-aws.yml migration wiring', () => {
  /**
   * The vacuity floor. Every other assertion in this file is a substring search,
   * and a substring search against an empty or truncated string fails in the
   * direction that looks like a real regression — but a wrong PATH would throw
   * at import instead, so the risk here is a file that reads but is not the
   * workflow. Pin two independent landmarks and a size.
   */
  it('read the real workflow, not an empty or unrelated file', () => {
    expect(workflow.length).toBeGreaterThan(2000);
    expect(workflow).toContain('name: Deploy to AWS');
    expect(workflow).toContain('bash .github/scripts/deploy-ecs-image.sh');
  });

  it('enables the migration run that deploy-ecs-image.sh leaves off by default', () => {
    expect(workflow).toContain("RUN_MIGRATIONS: 'true'");
  });

  /**
   * `--target-database` has no default in the migrator, deliberately: a run that
   * does not state its target cannot be checked against the connection string it
   * was handed, and a migration aimed at the wrong database does not fail — it
   * reports success over an untouched one. The workflow passes `env.APP`, so
   * this asserts the plumbing exists rather than retyping the name.
   */
  it('states the migration target rather than letting it default', () => {
    expect(workflow).toContain('MIGRATION_TARGET_DATABASE: ${{ env.APP }}');
  });

  it('greps for the post-phase marker with the pattern @oxyhq/db exports, not a copy', () => {
    expect(POST_PHASE_GREP_PATTERN).toBe('^-- oxy:deploy-phase=post$');
    expect(workflow).toContain(POST_PHASE_GREP_PATTERN);
  });

  it('points the post-phase grep at this package\'s migration directory', () => {
    expect(workflow).toContain('packages/api/drizzle');
  });

  /**
   * `runMigrations` takes NO lock — it reads the ledger's high-water mark
   * outside its transaction, so two concurrent runners read the same mark and
   * both attempt the same DDL. The package's own runner says so and assigns the
   * interlock to the caller, naming this exact case: a deploy's migration step
   * racing another deploy's.
   *
   * `cancel-in-progress: false` is the half that reads like a missed
   * optimisation and is the opposite: cancelling between `run-task` and its
   * exit-code check orphans a live migration task and reports nothing.
   */
  it('carries the workflow-level interlock the migrator requires', () => {
    expect(workflow).toMatch(/^concurrency:$/m);
    expect(workflow).toMatch(/^\s+cancel-in-progress: false$/m);
  });

  /**
   * Both invocations name `dist/db/migrate.js`, which exists only because
   * `build.ts` declares it as an entrypoint of its own. If somebody removes that
   * entrypoint the deploy fails at the one-shot task with a module-not-found,
   * which is loud — but the two halves are a single fact and belong in one
   * commit, so this states the dependency where a reader will see it.
   */
  it('invokes the migrate entrypoint build.ts actually emits', () => {
    const build = readFileSync(fileURLToPath(new URL('../../../build.ts', import.meta.url)), 'utf8');
    expect(build).toContain("entryPoints: ['src/db/migrate.ts']");
    expect(build).toContain("outfile: 'dist/db/migrate.js'");
    expect(workflow).toContain('packages/api/dist/db/migrate.js');
  });

  /**
   * The seeder has the migrator's failure mode exactly: the one-shot names a
   * file path, the runtime stage carries no `src/`, and nothing complains until
   * the command is issued against a real cluster.
   *
   * It differs in one way worth asserting separately — it runs on EVERY release,
   * not only when a post-phase migration exists. A seeder wired to the migration
   * marker would be a seeder that usually does not run, which is the shape this
   * whole change exists to remove.
   */
  it('invokes the seed entrypoint build.ts actually emits, on every release', () => {
    const build = readFileSync(fileURLToPath(new URL('../../../build.ts', import.meta.url)), 'utf8');
    expect(build).toContain("entryPoints: ['src/scripts/seed.ts']");
    expect(build).toContain("outfile: 'dist/scripts/seed.js'");
    expect(workflow).toContain('packages/api/dist/scripts/seed.js');

    // Unconditional: the seed command is assigned OUTSIDE the branch that tests
    // for a post-phase migration. If it moved inside, it would run only on
    // releases that happen to carry one.
    const step = workflow.slice(workflow.indexOf('id: phases'));
    const seedLine = step.slice(0, step.indexOf('>>"$GITHUB_OUTPUT"'));
    expect(seedLine).toMatch(/SEED='node packages\/api\/dist\/scripts\/seed\.js[^']*'/);
    expect(seedLine.indexOf('SEED=')).toBeLessThan(seedLine.indexOf('if grep -rlE'));

    // It must state its target, for the same reason the migrator must: `alia`
    // shares an instance with five other services.
    expect(workflow).toContain('dist/scripts/seed.js --target-database=alia');
  });
});
