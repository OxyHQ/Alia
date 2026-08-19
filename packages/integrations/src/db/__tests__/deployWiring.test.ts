/**
 * This package's deploy path, gated.
 *
 * ## Why this file exists at all
 *
 * `packages/integrations` had no deploy path. Not a broken one — an ABSENT one:
 * no ECS service, no ECR repository, and no workflow building its Dockerfile.
 * Every fix merged into this package, including the whole Mongo-to-Postgres
 * port, was undeliverable, and nothing anywhere was red about it. The sibling
 * lesson is the same shape: `deploy-ecs-image.sh` carried complete migration
 * support for the API's whole life and nothing ever set `RUN_MIGRATIONS`, so
 * nothing applied its migrations in any environment, greenly.
 *
 * A workflow and a Dockerfile are covered by no other gate in this repository —
 * not `tsc`, not the linter — so an assertion here is the only thing that can
 * notice the wiring going away again.
 *
 * ## What each assertion is actually for
 *
 * Two are load-bearing rather than descriptive.
 *
 * The Dockerfile check is the one that caught a real fault: the runtime stage
 * copied `dist` and nothing else, while `src/db/migrate.ts` resolves its
 * migrations as `join(__dirname, '..', '..', 'drizzle')`. Nothing had noticed
 * because nothing had ever run this migrator from a container.
 *
 * The two-databases check is the one whose absence is hardest to see. `@oxyhq/db`
 * fixes the ledger at `drizzle.__drizzle_migrations` with no per-service
 * namespacing and applies a migration only when its journal `when` is strictly
 * newer than the newest recorded one, so two packages migrating into one
 * database share a single high-water mark and strand each other.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// `@oxyhq/db/migrate`, not the root entry — the root export map does not
// re-export the migrate subpath, so importing it from there yields `undefined`
// and every substring assertion against it would compare against nothing.
import { POST_PHASE_GREP_PATTERN } from '@oxyhq/db/migrate';

// `__dirname`, not `import.meta.url`: this package's tsconfig is
// `module: commonjs`, so `import.meta` is a TS1343 under its own `type-check`.
// `src/db/__tests__/protectedReads.test.ts` resolves the same way.
const REPOSITORY_ROOT = join(__dirname, '..', '..', '..', '..', '..');

const repositoryFile = (path: string): string =>
  readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

const workflow = repositoryFile('.github/workflows/deploy-integrations.yml');
const dockerfile = repositoryFile('packages/integrations/Dockerfile');
const apiWorkflow = repositoryFile('.github/workflows/deploy-aws.yml');

describe('deploy-integrations.yml', () => {
  /**
   * The vacuity floor. Every other assertion here is a substring search, and a
   * substring search against a truncated string fails in the direction that
   * looks like a real regression — but a WRONG path throws at read time, so the
   * risk this covers is a file that reads and is not the workflow.
   */
  it('read the real workflow, not an empty or unrelated file', () => {
    expect(workflow.length).toBeGreaterThan(2000);
    expect(workflow).toContain('name: Deploy integrations');
    expect(workflow).toContain('bash .github/scripts/deploy-ecs-image.sh');
  });

  it('builds this package\'s Dockerfile, not the API\'s', () => {
    expect(workflow).toContain('DOCKERFILE: packages/integrations/Dockerfile');
  });

  it('enables the migration run that deploy-ecs-image.sh leaves off by default', () => {
    expect(workflow).toContain("RUN_MIGRATIONS: 'true'");
  });

  /**
   * The migrator path is a parameter of `deploy-ecs-image.sh`, defaulting to the
   * API's. A workflow that omits `MIGRATION_ENTRYPOINT` silently migrates the
   * WRONG package — and would then be refused by the target-database guard
   * rather than corrupting anything, which is a good failure but a confusing
   * one to diagnose from `expected "alia" but reaches "alia_integrations"`.
   */
  it('names this package\'s migrator rather than inheriting the default', () => {
    expect(workflow).toContain('MIGRATION_ENTRYPOINT: packages/integrations/dist/db/migrate.js');
  });

  it('greps for the post-phase marker with the pattern @oxyhq/db exports, not a copy', () => {
    expect(POST_PHASE_GREP_PATTERN).toBe('^-- oxy:deploy-phase=post$');
    expect(workflow).toContain(POST_PHASE_GREP_PATTERN);
  });

  it('points the post-phase grep at this package\'s migration directory', () => {
    expect(workflow).toContain('packages/integrations/drizzle');
  });

  /**
   * `runMigrations` takes NO lock — it reads the ledger's high-water mark outside
   * its transaction, so two concurrent runners both attempt the same DDL and the
   * loser exits 1 on an already-applied statement. The package assigns that
   * interlock to the caller, and for this deploy the caller is the workflow-level
   * concurrency group.
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
   * A group SHARED with the API deploy would serialise two unrelated rollouts.
   * Asserted as a difference rather than as a literal, so renaming either group
   * keeps working and merging them does not.
   */
  it('serialises against itself, not against the API deploy', () => {
    const groupOf = (text: string): string => {
      const match = text.match(/^concurrency:$(?:\n(?:\s*#.*)?)*?\n\s+group:\s*(\S+)/m);
      if (!match) throw new Error('no concurrency group found');
      return match[1];
    };
    expect(groupOf(workflow)).not.toBe(groupOf(apiWorkflow));
  });
});

describe('the two migrators do not share a database', () => {
  /**
   * The invariant, stated as a difference between the two workflows rather than
   * as either literal name, because what matters is that they cannot collide.
   *
   * Sharing one database is not a performance question. `@oxyhq/db`'s ledger
   * lives at a fixed `drizzle.__drizzle_migrations` with no per-service
   * namespacing, and `pendingEntries` is a high-water filter on the journal's
   * `when` timestamp, not a set difference. Whichever package migrated most
   * recently pushes the mark past the other's pending entries, and
   * `planLedgerRun` then throws `UnreachableMigrationError` for the loser —
   * permanently, since the fix that suggests itself (regenerate with a newer
   * `when`) strands the winner's next migration in the same way.
   *
   * The table names do NOT collide, which is what makes a shared database look
   * safe right up to the ledger.
   */
  it('states different --target-database values', () => {
    /**
     * Both workflows write `MIGRATION_TARGET_DATABASE: ${{ env.SOMETHING }}`, so
     * a naive regex extracts the literal `${{` from BOTH and reports them equal
     * — which is the answer that makes this test fail for the wrong reason, and
     * is what it did on its first run. Follow the reference into the
     * workflow-level `env:` block instead.
     */
    const resolvedTargetOf = (text: string): string => {
      const declared = text.match(/MIGRATION_TARGET_DATABASE:\s*(.+)/);
      if (!declared) throw new Error('no MIGRATION_TARGET_DATABASE found');
      const raw = declared[1].trim();

      const reference = raw.match(/^\$\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}$/);
      if (!reference) return raw;

      const resolved = text.match(new RegExp(`^  ${reference[1]}:\\s*(\\S+)$`, 'm'));
      if (!resolved) throw new Error(`env.${reference[1]} is referenced but not declared`);
      return resolved[1];
    };

    const integrations = resolvedTargetOf(workflow);
    const api = resolvedTargetOf(apiWorkflow);

    // Positive control, and the reason this test is worth having: assert both
    // resolved to a real NAME. Without it, two unresolved expressions compare
    // equal and this reads as a collision, while two failed matches would
    // compare equal too.
    expect(integrations).not.toContain('$');
    expect(api).not.toContain('$');
    expect(integrations).not.toBe(api);
  });
});

describe('packages/integrations/Dockerfile', () => {
  it('read the real Dockerfile', () => {
    expect(dockerfile.length).toBeGreaterThan(1000);
    expect(dockerfile).toContain('CMD ["node", "packages/integrations/dist/index.js"]');
  });

  /**
   * The migrations are DATA, so `tsc` does not put them in `dist` and the
   * runtime stage will not have them unless it is told to.
   *
   * This is the assertion that caught the fault rather than one written after
   * the fact to describe a fix: `src/db/migrate.ts` resolves
   * `join(__dirname, '..', '..', 'drizzle')`, which from `dist/db/` is
   * `/app/packages/integrations/drizzle`, and the image had no such path. It
   * fails loudly — @oxyhq/db's `readJournal` throws naming the missing file —
   * but only at the one-shot migration task, after a full ARM64 build, on the
   * step whose entire job is to run before the rollout that needs it.
   */
  it('ships the migrations directory next to the compiled migrator', () => {
    expect(dockerfile).toContain(
      'COPY --from=builder /build/packages/integrations/drizzle ./packages/integrations/drizzle',
    );
  });

  /**
   * The migrator is invoked with `node`, and the runtime stage is
   * `node:22-bookworm-slim`. A `bun` invocation would be a module-not-found at
   * deploy time; the two halves of that fact belong in one place.
   */
  it('runs a Node runtime, which is what the deploy invokes the migrator with', () => {
    expect(dockerfile).toContain('FROM node:22-bookworm-slim AS runtime');
    expect(workflow).toContain('MIGRATION_ENTRYPOINT: packages/integrations/dist/db/migrate.js');
  });
});
