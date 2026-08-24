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
const resolver = readFileSync(
  fileURLToPath(new URL('../../../../../.github/scripts/resolve-ecr-platform-digest.sh', import.meta.url)),
  'utf8',
);

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

  it('re-asserts both names of the API public origin on every task revision', () => {
    const from = workflow.indexOf('      - name: Stage the Kaana edge configuration');
    const to = workflow.indexOf('      # RUN_MIGRATIONS', from);
    const environmentStage = workflow.slice(from, to);

    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    expect(environmentStage).toContain('API_BASE_URL: "https://api.alia.onl"');
    expect(environmentStage).toContain('ALIA_API_URL: "https://api.alia.onl"');
    expect(environmentStage).toContain("jq -cs '.[0] * .[1] * .[2]'");
    // Required values merge last, so a future optional block cannot silently
    // override the canonical production origin.
    expect(environmentStage).toContain(
      '<(echo "${INTEGRATIONS_ENV:-{\\}}") <(echo "$kaana_env") <(echo "$required_env")',
    );
    expect(workflow).toContain(
      'TASK_ENV_OVERRIDES_JSON: ${{ steps.kaana.outputs.env_overrides }}',
    );
  });

  it('deploys the validated linux/arm64 child while retaining the provenance index', () => {
    expect(workflow).toContain('INDEX_DIGEST=$(jq -r');
    expect(workflow).toContain('bash .github/scripts/resolve-ecr-platform-digest.sh');
    expect(workflow).toContain('echo "index_digest=$INDEX_DIGEST" >>"$GITHUB_OUTPUT"');
    expect(workflow).toContain('echo "digest=$RUNTIME_DIGEST" >>"$GITHUB_OUTPUT"');
    expect(workflow).toContain('@${{ steps.build.outputs.digest }}');

    expect(resolver).toContain('docker buildx imagetools inspect --raw');
    expect(resolver).toContain('.platform.os == $os and .platform.architecture == $architecture');
    expect(resolver).toContain('Expected exactly one valid $TARGET_OS/$TARGET_ARCH runtime descriptor');
    expect(resolver).not.toContain('aws ecs');
    expect(resolver).not.toContain('run-task');
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
   * The `pre` and `post` phases must migrate the SAME package.
   *
   * The migrator path became a parameter of `deploy-ecs-image.sh`
   * (`MIGRATION_ENTRYPOINT`) when `packages/integrations` gained its own deploy
   * against its own database. That means this workflow now states the path
   * twice — once for the pre-phase step and once inside the post-phase command —
   * and two separately-written copies of one fact is exactly how a `pre` and a
   * `post` phase end up applied against different packages, which the ledger's
   * high-water rule turns into a permanent refusal rather than a retry.
   *
   * Extracted from the file rather than compared against a literal, so this
   * fails on a drift and not on a rename.
   */
  it('runs the pre and post phases against the same migrator', () => {
    const entrypoint = workflow.match(/MIGRATION_ENTRYPOINT:\s*(\S+)/);
    const postMigrate = workflow.match(/MIGRATE='node (\S+) /);

    // Positive control. A regex that stopped matching would otherwise let
    // `undefined === undefined` report agreement.
    expect(entrypoint?.[1]).toBeTruthy();
    expect(postMigrate?.[1]).toBeTruthy();
    expect(entrypoint?.[1]).toBe(postMigrate?.[1]);
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

/**
 * The bounds that stop a hung deploy from holding production.
 *
 * ## Why they need a gate at all
 *
 * A `timeout-minutes` is observable only when it TRIPS, and a correct one never
 * trips. So there is no green signal anywhere that says it is still there —
 * deleting both lines restores GitHub's 6-hour default and every deploy stays
 * exactly as green as it is now. That is the same shape as `RUN_MIGRATIONS`
 * above: an ABSENT step that looks like a working deploy.
 *
 * ## Why the job bound is derived rather than asserted literally
 *
 * `deploy-ecs-image.sh` bounds each of its own waits at `MAX_WAIT_SECS`, and
 * the job bound is only safe while it exceeds the longest chain of them. Pinning
 * `105` as a literal would keep passing after somebody doubles `MAX_WAIT_SECS`,
 * at which point the job timeout starts killing the script mid-rollback — the
 * one outcome the workflow's `concurrency` comment exists to prevent. So the
 * ceiling is recomputed from the script, exactly as the grep pattern above is
 * compared against the constant `@oxyhq/db` exports rather than a retyped copy.
 */
describe('deploy-aws.yml stall bounds', () => {
  const script = readFileSync(fileURLToPath(new URL('../../../../../.github/scripts/deploy-ecs-image.sh', import.meta.url)), 'utf8');

  /** The `deploy` job's own attributes, i.e. everything before its `steps:`. */
  const jobHeader = workflow.slice(workflow.indexOf('  deploy:'), workflow.indexOf('\n    steps:'));

  /** The `Build and push` step, up to the start of the next one. */
  const buildStep = (() => {
    const from = workflow.indexOf('      - name: Build and push (linux/arm64)');
    return workflow.slice(from, workflow.indexOf('\n      - name: ', from + 1));
  })();

  const minutesIn = (block: string): number | null => {
    const match = block.match(/^\s+timeout-minutes: (\d+)$/m);
    return match ? Number(match[1]) : null;
  };

  /**
   * The vacuity floor for this block specifically. Both slices are index-based,
   * and an index that misses returns a short or empty string — against which
   * every `timeout-minutes` search below reports ABSENT, which is indistinguishable
   * from the regression. Pin that each slice is the region it claims to be.
   */
  it('sliced the job header and the build step, not empty strings', () => {
    expect(jobHeader).toContain('runs-on: ubuntu-24.04-arm');
    expect(jobHeader).not.toContain('- name: Build and push');
    expect(buildStep).toContain('docker buildx build');
    expect(buildStep).toContain('--metadata-file');
  });

  /**
   * The tight one, on the step that actually hung: three stalls on 2026-08-19
   * froze at `RUN bun install` and emitted nothing for the following 40+
   * minutes, against a slowest-of-100 successful builds of 2m44s.
   */
  it('bounds the build step well above its slowest observed run', () => {
    const build = minutesIn(buildStep);
    expect(build).not.toBeNull();
    // 2m44s was the slowest of the 100 successful runs measured over ten days,
    // and nothing caches between runs, so that sample is already the cold case.
    expect(build).toBeGreaterThanOrEqual(10);
    // Above ~30 the bound stops being worth having: the shortest of the three
    // observed stalls ran 38 minutes before a human noticed and cancelled it.
    expect(build).toBeLessThanOrEqual(30);
  });

  /**
   * The backstop, which must never preempt the deploy script's own error
   * handling. Four sequential `MAX_WAIT_SECS` waits are reachable on this
   * workflow's configuration — the pre-phase migration one-shot, the rollout,
   * the post-deploy reconciliation one-shot, and the rollback that a failure of
   * the last one triggers.
   */
  it('bounds the job above the deploy script\'s own ceiling', () => {
    const declared = script.match(/^MAX_WAIT_SECS="\$\{MAX_WAIT_SECS:-(\d+)\}"$/m);
    expect(declared).not.toBeNull();
    const maxWaitMinutes = Number(declared?.[1]) / 60;
    expect(maxWaitMinutes).toBeGreaterThan(0);

    const job = minutesIn(jobHeader);
    const build = minutesIn(buildStep);
    expect(job).not.toBeNull();
    expect(build).not.toBeNull();
    expect(job).toBeGreaterThanOrEqual(4 * maxWaitMinutes + Number(build));
    // And it must still beat the 6-hour default it replaces, or it is theatre.
    expect(job).toBeLessThan(360);
  });
});

/**
 * The static IAM user's keys stop being injected, and the removal is real.
 *
 * Two halves, because either alone is green and inert. The workflow can declare
 * a removal the script ignores, and the script can grow a removal hook nothing
 * ever names — and the second is how the injection would quietly survive: the
 * render carries `.secrets` FORWARD from the running revision, so every future
 * revision descends from one that carries them.
 */
describe('the deploy stops injecting the static AWS credentials', () => {
  const script = readFileSync(
    fileURLToPath(new URL('../../../../../.github/scripts/deploy-ecs-image.sh', import.meta.url)),
    'utf8',
  );

  it('the workflow names both variables for removal', () => {
    const declared = /TASK_SECRET_REMOVALS_JSON:\s*'(\[.*?\])'/.exec(workflow);
    expect(declared, 'the workflow declares no removals').not.toBeNull();
    expect(JSON.parse(declared![1]).sort()).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  });

  it('and the render actually filters on that list', () => {
    // The wiring, not the declaration: the carried-forward `.secrets` must be
    // filtered by the removals, in the same expression that filters by the
    // override names.
    expect(script).toContain('--argjson taskSecretRemovals "$TASK_SECRET_REMOVALS_JSON"');
    expect(script).toMatch(/\$taskSecretRemovals \| index\(\$existingName\)\) == null/);
  });

  it('refuses a variable that is both removed and replaced', () => {
    // A contradiction resolved silently is a contradiction nobody sees.
    expect(script).toContain('TASK_SECRET_REMOVALS_JSON and TASK_SECRET_OVERRIDES_JSON name the same variable');
  });

  it('and the code can survive their absence', () => {
    // The half that makes the removal safe rather than an outage: an S3 client
    // built with an EMPTY credential signs with nothing. `lib/s3.ts` must omit
    // the key entirely so the SDK resolves the task role.
    const s3 = readFileSync(fileURLToPath(new URL('../../lib/s3.ts', import.meta.url)), 'utf8');
    expect(s3).toContain('resolveS3Credentials');
    expect(s3).not.toContain("process.env.AWS_ACCESS_KEY_ID || ''");
  });
});
