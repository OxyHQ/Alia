/**
 * The workspace typecheck gate — epic #139.
 *
 * ## Why this is a partition and not a list of packages to check
 *
 * The obvious job — `bun run --filter @alia/app typecheck` and one more line per
 * package — is a gate that only ever covers what somebody remembered to add. Six
 * of this repo's twelve workspaces had no typecheck at all when this was written,
 * and nothing anywhere would have reported that; the omission is invisible
 * precisely because a missing line looks exactly like a package that does not
 * need one.
 *
 * So this enumerates the workspaces from the root `package.json` and requires
 * every one of them to land in exactly one of four buckets. A package added to
 * the monorepo belongs to none of them, and this fails until someone says which.
 *
 *  - {@link CHECKED_ELSEWHERE} — already typechecked by a named CI job. Running
 *    them again here would double the runner time and, worse, would make a
 *    failure appear in two places with two different job names.
 *  - {@link EXCLUDED} — has a `typecheck` script that does NOT pass today. Named
 *    individually, with the error count that was measured, and asserted to still
 *    be failing: an exclusion that has quietly started passing is an exclusion
 *    that should be deleted, and this is what makes that a build failure rather
 *    than a thing nobody notices.
 *  - {@link NO_TYPECHECK} — no `typecheck` script, with the reason. Two of them
 *    are `tsc -b` solution-style projects whose `tsconfig.json` has `"files": []`
 *    and only `references`, so `tsc --noEmit` there compiles NOTHING and exits 0
 *    — a script that would have reported a clean pass while measuring nothing.
 *  - everything else — checked here, discovered rather than listed, so a package
 *    that gains a `typecheck` script is covered by this job the same day.
 *
 * Every list carries an exact-count assertion, because a list of exemptions
 * without one erodes one defensible entry at a time.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

interface Workspace {
  readonly dir: string;
  readonly name: string;
  readonly hasTypecheck: boolean;
}

function readWorkspaces(): Workspace[] {
  const root = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const dirs = root.workspaces ?? [];
  if (dirs.length === 0) {
    throw new Error('the root package.json declares no workspaces — nothing to check');
  }
  return dirs.map((dir) => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, dir, 'package.json'), 'utf8'),
    ) as { name: string; scripts?: Record<string, string> };
    return {
      dir,
      name: manifest.name,
      hasTypecheck: typeof manifest.scripts?.typecheck === 'string',
    };
  });
}

/**
 * Typechecked by another job, which is named so a reader can go and look.
 *
 * `@alia/integrations` spells its script `type-check`, which is why it does not
 * appear to have one below. It is checked; the name is just different, and
 * renaming someone else's script from this PR would be a change to a package
 * this gate is only supposed to observe.
 */
const CHECKED_ELSEWHERE: Readonly<Record<string, string>> = {
  '@alia/api': 'Lint & Test — "Typecheck API"',
  '@alia.onl/sdk': 'Lint & Test — "Typecheck SDK"',
  '@alia/integrations': 'Integrations (Postgres) — "Typecheck integrations" (script is `type-check`)',
};

/**
 * Has a `typecheck` script that does not pass yet.
 *
 * The count is the number of `error TS` lines measured on `60a67f2e`. It is
 * recorded so that a package getting WORSE is visible, and so that "we excluded
 * two packages" cannot quietly become "we excluded two packages and 300 errors".
 */
const EXCLUDED: Readonly<Record<string, { readonly errors: number; readonly why: string }>> = {};

/** Has no `typecheck` script, and why that is the right answer for it. */
const NO_TYPECHECK: Readonly<Record<string, string>> = {
  'alia-canvas': 'solution-style tsconfig ("files": [], references only) — `tsc --noEmit` compiles nothing; checked by the "Typecheck the solution-style frontends" step of Frontend Typecheck, which runs `tsc -b` on it',
  'webview-ui': 'same solution-style tsconfig; checked by the same `tsc -b` step',
  '@alia/docker-host': 'its `build` is `tsc`, which typechecks while emitting',
};

function assertPartition(workspaces: readonly Workspace[]): string[] {
  const names = workspaces.map((w) => w.name);
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length > 0) {
    throw new Error(`two workspaces share a name: ${duplicates.join(', ')}`);
  }

  const problems: string[] = [];

  // Every named entry must name a REAL workspace. Without this a rename turns an
  // exclusion into a no-op and the package silently rejoins the checked set — or,
  // worse, silently leaves it.
  for (const [bucket, entries] of [
    ['CHECKED_ELSEWHERE', Object.keys(CHECKED_ELSEWHERE)],
    ['EXCLUDED', Object.keys(EXCLUDED)],
    ['NO_TYPECHECK', Object.keys(NO_TYPECHECK)],
  ] as const) {
    for (const name of entries) {
      if (!names.includes(name)) problems.push(`${bucket} names ${name}, which is not a workspace`);
    }
  }

  for (const workspace of workspaces) {
    const buckets = [
      workspace.name in CHECKED_ELSEWHERE ? 'CHECKED_ELSEWHERE' : null,
      workspace.name in EXCLUDED ? 'EXCLUDED' : null,
      workspace.name in NO_TYPECHECK ? 'NO_TYPECHECK' : null,
    ].filter((bucket) => bucket !== null);

    if (buckets.length > 1) {
      problems.push(`${workspace.name} is in ${buckets.join(' and ')}`);
    }

    // A package listed as having no typecheck script that has since gained one,
    // or an excluded package that has lost its script, is a stale list.
    if (workspace.name in NO_TYPECHECK && workspace.hasTypecheck) {
      problems.push(`${workspace.name} is in NO_TYPECHECK but now has a typecheck script — move it`);
    }
    if (workspace.name in EXCLUDED && !workspace.hasTypecheck) {
      problems.push(`${workspace.name} is EXCLUDED but has no typecheck script — it belongs in NO_TYPECHECK`);
    }
    if (buckets.length === 0 && !workspace.hasTypecheck) {
      problems.push(
        `${workspace.name} has no typecheck script and is in no list — add a typecheck script, or say why not in NO_TYPECHECK`,
      );
    }
  }

  return problems;
}

function main(): void {
  const workspaces = readWorkspaces();

  // Exact counts. Each list may only change in a diff that also changes the
  // number beside it, which is the review this gate exists to force.
  const counts: readonly [string, number, number][] = [
    ['workspaces', workspaces.length, 11],
    ['CHECKED_ELSEWHERE', Object.keys(CHECKED_ELSEWHERE).length, 3],
    ['EXCLUDED', Object.keys(EXCLUDED).length, 0],
    ['NO_TYPECHECK', Object.keys(NO_TYPECHECK).length, 3],
  ];
  const countProblems = counts
    .filter(([, actual, expected]) => actual !== expected)
    .map(([label, actual, expected]) => `${label}: expected ${expected}, found ${actual}`);

  const problems = [...countProblems, ...assertPartition(workspaces)];
  if (problems.length > 0) {
    console.error('The workspace typecheck partition is out of date:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const checked = workspaces.filter(
    (w) =>
      !(w.name in CHECKED_ELSEWHERE) && !(w.name in EXCLUDED) && !(w.name in NO_TYPECHECK),
  );

  // The vacuity floor. An empty checked set satisfies "no package failed", and a
  // filter bug, a renamed workspace or an over-grown exclusion list all produce
  // exactly that.
  if (checked.length < 3) {
    console.error(`Only ${checked.length} workspace(s) would be checked; the gate has eroded.`);
    process.exit(1);
  }

  console.log(`Typechecking ${checked.length} workspaces: ${checked.map((w) => w.name).join(', ')}`);
  for (const [name, why] of Object.entries(CHECKED_ELSEWHERE)) console.log(`  elsewhere: ${name} — ${why}`);
  for (const [name, { errors, why }] of Object.entries(EXCLUDED)) console.log(`  excluded:  ${name} (${errors} errors) — ${why}`);
  for (const [name, why] of Object.entries(NO_TYPECHECK)) console.log(`  no script: ${name} — ${why}`);

  const typecheck = (name: string, stdio: 'inherit' | 'ignore'): boolean =>
    spawnSync('bun', ['run', '--filter', name, 'typecheck'], { cwd: REPO_ROOT, stdio }).status === 0;

  const failed: string[] = [];
  for (const workspace of checked) {
    console.log(`\n=== ${workspace.name} ===`);
    if (!typecheck(workspace.name, 'inherit')) failed.push(workspace.name);
  }

  /**
   * An exclusion that has started passing is an exclusion to delete.
   *
   * Without this the list is write-only: somebody fixes a package, nothing
   * notices, and the entry sits there forever excusing a package that no longer
   * needs excusing — which is how an exemption list stops describing anything.
   * The recorded `errors` count is deliberately NOT asserted: any new error
   * would change it, and a gate that fires on the number rather than on the
   * state would be re-pinned rather than read.
   */
  const fixed = Object.keys(EXCLUDED).filter((name) => typecheck(name, 'ignore'));
  if (fixed.length > 0) {
    console.error(
      `\nThese packages are EXCLUDED but now typecheck clean: ${fixed.join(', ')}.` +
        '\nDelete their entries from EXCLUDED and lower its count in the same commit.',
    );
    process.exit(1);
  }

  /**
   * The obvious hazard here would be a filter that matched nothing reporting a
   * clean pass. Measured on bun 1.3.14: `bun run --filter <no-match> typecheck`
   * prints "No packages matched the filter" and exits **1**, and so does a real
   * workspace that has no such script. Both therefore land in `failed` rather
   * than passing silently, which is why no extra assertion is needed for it.
   */
  if (failed.length > 0) {
    console.error(`\nTypecheck failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll checked workspaces typecheck clean.');
}

main();
