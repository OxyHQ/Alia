import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every table seeder is wired to the entrypoint that actually runs, or named as
 * deliberately unwired.
 *
 * ## The defect this exists for has now happened TWICE
 *
 * A seeder whose caller cannot fire reads as WIRED from any single call site.
 * `startBackgroundServices()` in `src/index.ts` is reached only from
 * `connectDB().then(...)` — a Mongo connection that no longer exists and never
 * resolves — so everything placed there runs never.
 *
 * `plans` was the first instance: production holds 0 rows and every account
 * falls to the free floor, with a green deploy throughout. `skills` was the
 * second, and it was left there *deliberately*, with a note saying so — which is
 * the part that makes this gate necessary rather than merely useful. **A
 * deliberate dead call and an accidental one are indistinguishable a month
 * later.** Both were found by reading the boot path, not by anything failing.
 *
 * `deployWorkflow.test.ts` guards the step that RUNS `scripts/seed.ts`. This
 * guards what that script CONTAINS. Neither implies the other: the workflow can
 * invoke a seed entrypoint that seeds six of seven tables and exit 0.
 *
 * ## The population is structural, never derived from names
 *
 * A table seeder is an exported `async function seed…()` taking NO ARGUMENTS,
 * in `src/lib/seed-*.ts` or `src/internal/providers/lib/seed-*.ts`. Arity is
 * what separates them from the per-row helpers under `db/` — `seedPlan(input)`
 * and `seedPlanFeatures(rows)` are repository functions with the same prefix,
 * and a name-based rule would either sweep them in or, worse, be tuned until it
 * did not and quietly lose a real seeder with an unexpected name.
 *
 * ## `scripts/seed.ts` is read as TEXT, deliberately
 *
 * It calls `main()` at module scope and `process.exit()` in both settlements, so
 * importing it to read `SEEDERS` would run a seed — against whatever
 * `DATABASE_URL` the suite happens to carry — and then kill the vitest worker.
 */

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** Files that may define a table seeder. Two directories, both spelled out. */
function seederFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', 'src/lib/seed-*.ts', 'src/internal/providers/lib/seed-*.ts'],
    { cwd: PACKAGE_ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

/** Exported zero-argument seeders, by name. */
function tableSeeders(): string[] {
  return seederFiles().flatMap((file) =>
    [...readFileSync(path.join(PACKAGE_ROOT, file), 'utf8').matchAll(
      /export async function (seed[A-Za-z]+)\(\)/g,
    )].map((match) => match[1]),
  );
}

const seedScript = readFileSync(path.join(PACKAGE_ROOT, 'src/scripts/seed.ts'), 'utf8');

/**
 * The `SEEDERS` array's `run:` values, which is what the loop actually calls.
 *
 * Matched on `run: <name>` rather than on the import, because an import that
 * nothing puts in the array is exactly the state this gate is looking for.
 */
function wiredSeeders(): string[] {
  const start = seedScript.indexOf('const SEEDERS');
  const end = seedScript.indexOf('];', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...seedScript.slice(start, end).matchAll(/run:\s*(seed[A-Za-z]+)/g)].map((m) => m[1]);
}

/**
 * Seeders that must NOT run at the deploy boundary, and why.
 *
 * This list may only shrink in practice, but it is not frozen — a genuinely new
 * unwired seeder is possible. What stops it growing quietly is the exact-count
 * assertion below: adding a member is a visible edit to a number, not a
 * defensible-looking line appended to a list.
 */
const DELIBERATELY_UNWIRED: Readonly<Record<string, string>> = {
  seedBots:
    'Derives the bot id from TELEGRAM_BOT_TOKEN / DISCORD_APP_ID, neither of which the task definition sets. Running it writes rows keyed on the literal placeholders `telegram-bot` and `discord-bot`, which change the moment real credentials arrive — a wrong row that looks right.',
};

describe('every table seeder reaches the entrypoint that runs', () => {
  it('found a real population, in both seeder directories', () => {
    /**
     * Vacuity floor, and it needs BOTH halves. A broken `git ls-files`, a wrong
     * cwd or a regex that matches nothing all report "every seeder is wired"
     * identically to a correct tree — and a glob covering only one directory
     * would report clean while missing five.
     */
    const files = seederFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.some((f) => f.startsWith('src/lib/'))).toBe(true);
    expect(files.some((f) => f.startsWith('src/internal/providers/lib/'))).toBe(true);

    const seeders = tableSeeders();
    expect(seeders.length).toBeGreaterThanOrEqual(9);
    // Positive control on the MATCHER: two known members, one per directory.
    expect(seeders).toContain('seedSkills');
    expect(seeders).toContain('seedModelConfigs');
    // Negative control: the per-row repository helpers take arguments and must
    // not be swept in, or the exemption list becomes a dumping ground.
    expect(seeders).not.toContain('seedPlan');
  });

  it('reads the SEEDERS array and finds what it actually calls', () => {
    const wired = wiredSeeders();
    // Vacuity floor on the second input. A slice that captured nothing would
    // make every seeder look unwired, which fails loudly — but a slice that
    // captured the WHOLE file would make every seeder look wired, which does
    // not. This is the floor for the second case.
    expect(wired.length).toBeGreaterThanOrEqual(8);
    expect(wired).toContain('seedSkills');
    expect(wired).not.toContain('seedBots');
  });

  it('wires every table seeder, or names it as deliberately unwired', () => {
    const wired = new Set(wiredSeeders());
    const unaccounted = tableSeeders().filter(
      (name) => !wired.has(name) && !(name in DELIBERATELY_UNWIRED),
    );

    // A seeder in neither place is the `plans` failure exactly: defined,
    // exported, reachable from nothing that runs, and green everywhere.
    expect(unaccounted).toEqual([]);
  });

  it('keeps the exemption list to its exact size, with a reason each', () => {
    /**
     * A list of exemptions needs its own exact-count assertion. Without it this
     * gate switches itself off one defensible line at a time — the cheapest way
     * to make it pass is always to add a member, and the terminus is a gate that
     * exempts everything.
     */
    expect(Object.keys(DELIBERATELY_UNWIRED)).toEqual(['seedBots']);
    // Each reason has to SAY something. A one-word placeholder is how an
    // exemption gets added without anyone having to defend it.
    const unreasoned = Object.entries(DELIBERATELY_UNWIRED)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([name]) => name);
    expect(unreasoned).toEqual([]);
  });

  it('does not leave a seeder call on the boot path that cannot fire', () => {
    /**
     * The other half, and the one that would have caught both instances. A
     * seeder can be wired to `scripts/seed.ts` AND still be called from
     * `startBackgroundServices()`, where it runs never — two callers, one of
     * which is a lie. The exemption above is about which seeders RUN; this is
     * about where they are called FROM.
     */
    const index = readFileSync(path.join(PACKAGE_ROOT, 'src/index.ts'), 'utf8');
    const called = [...index.matchAll(/\b(seed[A-Za-z]+)\(\)/g)].map((m) => m[1]);

    // Positive control: `seedBots` IS still called here, so an empty match means
    // the matcher broke rather than that the boot path is clean.
    expect(called).toContain('seedBots');

    const wired = new Set(wiredSeeders());
    expect(called.filter((name) => wired.has(name))).toEqual([]);
  });
});
