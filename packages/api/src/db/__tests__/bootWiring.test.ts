import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The boot wiring that nothing else can observe.
 *
 * `src/index.ts` opens a socket and starts timers on import, so no test imports
 * it. That is exactly why this gate exists: the expiry sweeper was written,
 * registered against fourteen targets and covered by real-database tests, and
 * **nothing ever called `startExpirySweeper()`**. Every one of those tests
 * invoked `runExpirySweep()` directly, so the whole mechanism was green and
 * inert at the same time — the sweep worked and was never run.
 *
 * A source-text assertion is weak evidence about behaviour, and it is the
 * strongest available here. It is the same shape `deployWorkflow.test.ts` uses
 * for the workflow YAML, and it fails for the one reason that actually occurred:
 * the call being absent.
 *
 * The vacuity floor matters more than usual. `readFileSync` of a path that
 * moved, or a file emptied by a bad merge, produces a string containing none of
 * these markers — which is indistinguishable from a correct file that lost the
 * call, and would report the same "not found" either way. So the file is
 * asserted to be recognisably `index.ts` first.
 */

const INDEX = join(__dirname, '..', '..', 'index.ts');
const source = readFileSync(INDEX, 'utf8');
const code = stripComments(source);

/**
 * Not one Mongoose driver is reachable from the boot path.
 *
 * ## Why a graph walk and not a grep
 *
 * `git grep mongoose` over this package finds many historical comments and
 * answers the wrong question. A grep that counts them cannot distinguish those
 * migration notes from `import mongoose from 'mongoose'` two hops down a
 * repository chain. What matters is whether a module the entrypoint actually
 * loads pulls the driver in.
 *
 * So this resolves the real import graph from `src/index.ts` — static imports,
 * re-exports and dynamic `import()` alike — and asks which bare specifiers it
 * reaches. `src/index.ts` cannot be imported (it opens a socket), which is why
 * the graph is read from source rather than from `import.meta`.
 *
 * ## The two controls, and what each of them would catch
 *
 * A walker that resolved nothing would report "no mongoose" from any entrypoint,
 * which is indistinguishable from a clean tree. TRAVERSAL is controlled against
 * `drizzle-orm`, which `src/index.ts` does not import directly and which must
 * therefore be found through a chain of at least two files. The package-wide
 * importer census below has its own positive control over the same source tree.
 */
const PACKAGE_SRC = resolve(__dirname, '..', '..');
const PACKAGE_ROOT = resolve(PACKAGE_SRC, '..');

/** Block comments and whole-line `//` comments contain the migration-history mentions. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Every specifier the file imports, however it spells it. */
function importSpecifiers(text: string): string[] {
  const code = stripComments(text);
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g)],
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)],
  ].map((match) => match[1]);
}

/** The `.js` specifiers this package writes resolve to `.ts` files on disk. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base.replace(/\.js$/, '')}/index.ts`,
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

interface Walk {
  /** First-party files loaded, relative to `src/`. */
  readonly files: readonly string[];
  /** Bare specifier -> the chain of first-party files that reaches it. */
  readonly externals: ReadonlyMap<string, readonly string[]>;
}

function walkFrom(entry: string): Walk {
  const start = resolve(PACKAGE_SRC, entry);
  const parent = new Map<string, string>();
  const seen = new Set<string>([start]);
  const externals = new Map<string, string[]>();
  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let cursor: string | undefined = file; cursor !== undefined; cursor = parent.get(cursor)) {
      chain.push(relative(PACKAGE_SRC, cursor));
    }
    return chain.reverse();
  };

  const pending = [start];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined) break;
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        if (!externals.has(specifier)) externals.set(specifier, chainTo(file));
        continue;
      }
      const resolved = resolveRelative(file, specifier);
      // A relative specifier that does not resolve is a broken import; `tsc`
      // owns that failure, and swallowing it here would hide a whole subtree.
      expect(resolved, `${relative(PACKAGE_SRC, file)} imports ${specifier}`).not.toBeNull();
      if (resolved === null || seen.has(resolved)) continue;
      seen.add(resolved);
      parent.set(resolved, file);
      pending.push(resolved);
    }
  }

  return { files: [...seen].map((file) => relative(PACKAGE_SRC, file)), externals };
}

describe('src/index.ts boot wiring', () => {
  it('read an index.ts that is really the server entrypoint', () => {
    // Vacuity floor: without this, every assertion below passes on an empty
    // read for reasons that have nothing to do with the wiring.
    expect(source.length).toBeGreaterThan(5_000);
    expect(source).toContain("server.listen(PORT");
    expect(source).toContain("import express from 'express'");
  });

  it('starts the expiry sweeper', () => {
    // The 14 TTL indexes this service used to have are now rows that only this
    // loop deletes. Without the call they are never deleted at all.
    expect(source).toContain('startExpirySweeper()');
  });

  it('stops the expiry sweeper on shutdown', () => {
    expect(source).toContain('stopExpirySweeper()');
  });

  it('runs every boot refusal before the socket opens', () => {
    /**
     * Order, not just presence: a refusal that happened inside the `listen`
     * callback would accept requests first and exit afterwards, which is the
     * half-configured state these guards exist to prevent.
     *
     * The leading newline is load-bearing, and the reason is worth keeping even
     * though the shape changed. `connectPostgresOrExit()` used to be a substring
     * of its own declaration — `function connectPostgresOrExit(): void` — so a
     * bare search found the declaration instead, 1141 characters earlier and
     * also before `listen`. That assertion passed with the CALL deleted, which
     * is the only way it could ever have failed. Anchoring on a top-level
     * statement is what makes it a check.
     *
     * WHICH refusals run, in WHAT order, and that each one TERMINATES is now
     * `lib/__tests__/boot-guards.test.ts`, against the real function. Four
     * source-text assertions used to stand here in its place, and they were
     * measurably not enough: the direct-provider guard was able to lose its
     * `process.exit` — reporting the problem and starting anyway — with every
     * suite in the repo green.
     */
    const guardsAt = source.indexOf('\nrunBootGuards({');
    const listenAt = source.indexOf('server.listen(PORT');
    expect(guardsAt).toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(guardsAt).toBeLessThan(listenAt);
  });

  it('hands the boot guards the REAL terminator and the real logger', () => {
    /*
     * The one thing only this file can see. `runBootGuards` takes `exit` as a
     * parameter so that a test can assert termination — which means a call site
     * passing a no-op would satisfy every behavioural assertion in
     * `lib/__tests__/boot-guards.test.ts` while the process started anyway.
     *
     * Still source text, and still not proof; it is the residue the extraction
     * could not remove, and it is smaller than the four assertions it replaced.
     */
    const guardsAt = source.indexOf('\nrunBootGuards({');
    const call = source.slice(guardsAt, guardsAt + 600);
    expect(call).toContain('process.exit(code)');
    expect(call).toContain('log.general.error');
    expect(call).toContain('log.general.info');
  });

  it('no longer runs the retired Mongo data-migration ledger', () => {
    // `lib/migrations/` is deleted; a reintroduced call would be a second
    // migration ledger beside `@oxyhq/db`'s, asserting history that never
    // happened. See CONVENTIONS.md, "Two migration ledgers must not both survive".
    expect(source).not.toContain('runPendingMigrations');
  });

  it('starts the background services, unconditionally, from the listen callback', () => {
    /**
     * The defect this replaces, stated so the assertion is legible: the call was
     * `connectDB().then(() => startBackgroundServices())`, and `MONGODB_URI` left
     * the task definition at the Mongo decommission — so the retry loop backed
     * off forever and the trigger engine, the moderation-outbox dispatcher, both
     * queues and the container pool never started in production once.
     *
     * WHAT starts, in what order, and that a rejecting starter cannot stop the
     * rest is `lib/__tests__/background-services.test.ts`, against the real
     * function. This is the residue only a census can see: that the call is here,
     * that it is inside `listen`, and that nothing gates it.
     */
    const listenAt = source.indexOf('server.listen(PORT');
    const startAt = source.indexOf('startBackgroundServices();');
    expect(listenAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(listenAt);

    /*
     * And nothing gates it. Anchored on the whole file rather than the window
     * between `listen` and the call, because a gate reintroduced ANYWHERE is the
     * same defect — and on comment-stripped source, because the comment above
     * that call names `connectDB()` as the thing that was removed. A census that
     * cannot tell prose from code fails on its own documentation.
     */
    expect(code).not.toMatch(/\bconnectWithRetry\b/);
    expect(code).not.toMatch(/\bconnectDB\b/);
    // Positive control on the stripper: it must not be eating the code as well.
    expect(code).toMatch(/\bstartBackgroundServices\(\)/);
  });

  it('stops the background services on shutdown', () => {
    // Started and never stopped is a leak on every SIGTERM, and for the trigger
    // engine specifically it strands the leadership lease — no other task
    // schedules anything until the TTL expires.
    expect(source).toContain('await stopBackgroundServices();');
  });
});

describe('the boot path reaches no MongoDB driver', () => {
  const boot = walkFrom('index.ts');

  it('walked a real graph, several hops deep', () => {
    /*
     * TRAVERSAL control plus the vacuity floor. `drizzle-orm` is reached only
     * through the repositories, so a walker that stopped at the entrypoint's own
     * imports would miss it — and would then report a clean bill of health for
     * every transitive Mongoose import as well.
     */
    expect(boot.files.length).toBeGreaterThan(300);
    expect(boot.files).toContain('lib/background-services.ts');
    const drizzle = boot.externals.get('drizzle-orm');
    expect(drizzle).toBeDefined();
    expect(drizzle?.length).toBeGreaterThan(1);
    expect(drizzle?.[0]).toBe('index.ts');
  });

  it('never reaches mongoose or the raw driver from src/index.ts', () => {
    const drivers = [...boot.externals.keys()].filter(
      (specifier) => specifier === 'mongoose' || specifier === 'mongodb' || specifier.startsWith('mongodb/'),
    );
    expect(drivers).toEqual([]);
  });
});

/**
 * The Mongo driver's whole remaining surface in this package, frozen as an
 * EXACT SET rather than as a boundary.
 *
 * The walk above answers "can the server reach it", which is the question that
 * matters for a request in production. It is not the question that matters for
 * the port, because a Mongoose model declared today would be unreachable from
 * `index.ts` on the day it was written and reachable a route later — and by then
 * the schema exists, its uniqueness is unrecorded and its TTL has no sweep.
 *
 * ## This freeze is what two retired gates were replaced BY
 *
 * `models/__tests__/foreign-ref-populate.test.ts` walked the registered schemas
 * for dangling `ref:` declarations and `db/__tests__/ttlRegistryCoverage.test.ts`
 * walked them for `expireAfterSeconds`. Both walks returned `[]` once the last
 * model was deleted, and an empty walk reports "no violations" identically to a
 * walk that broke — so neither could still tell whether a model had come back.
 * Keeping Mongoose installed to run them would also have made the dependency
 * self-justifying: the only importer left would be the gate proving there are no
 * importers.
 *
 * A set equality over the importers answers the same question without needing a
 * single model to exist, catches a model declared ANYWHERE rather than only in
 * the two directories those walks enumerated, and cannot pass by finding
 * nothing — an empty result fails it just as loudly as a wrong one.
 *
 * There is no exception list. The former backup-only purge script could not
 * reach the destroyed source database and kept the whole driver installed, so
 * it and the dependency were retired together. Any new importer is therefore a
 * second store with no migration ledger and must fail this gate.
 */
describe('the Mongo drivers have no first-party surface', () => {
  /** Every tracked TypeScript source in this package, relative to the package root. */
  function trackedSources(): string[] {
    return execFileSync('git', ['ls-files', 'src'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((file) => /\.ts$/.test(file) && existsSync(join(PACKAGE_ROOT, file)));
  }

  /**
   * Files whose CODE names `pkg` as a module specifier, in any spelling —
   * `from`, a bare `import`, a dynamic `import()` or a `require()`.
   *
   * Comments are stripped first, and that is the whole difficulty. Many files
   * under `src/` contain prose recording what the Mongo version of a query did,
   * and those citations are load-bearing — `retiredModelFiles.ts` and
   * `ttlRegistryCoverage.test.ts` are nothing but citations. A text census
   * cannot be made to tell one from an import, so it is not attempted.
   */
  function importersOf(pkg: string): string[] {
    const pattern = new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"]${pkg}(?:/[^'"]*)?['"]`);
    return trackedSources().filter((file) =>
      pattern.test(stripComments(readFileSync(join(PACKAGE_ROOT, file), 'utf8'))),
    );
  }

  it('scanned a real tree, and the matcher finds real imports', () => {
    /*
     * Vacuity floor on the INPUT. A broken `git ls-files`, a wrong cwd or an
     * empty checkout report "no importers" identically to a clean tree.
     */
    expect(trackedSources().length).toBeGreaterThan(500);

    /*
     * POSITIVE CONTROL on the matcher and the comment stripper together, run
     * over the same tree in the same currency as the measurement. `drizzle-orm`
     * is imported throughout the repositories and the schema; a pattern that
     * matched nothing, or a stripper that ate the code along with the comments,
     * would report zero here and a clean bill of health below.
     */
    expect(importersOf('drizzle-orm').length).toBeGreaterThan(50);
  });

  it('does not simply count every file that mentions Mongo', () => {
    /*
     * DISCRIMINATION control, and the one this census actually needs. The
     * failure it guards is a stripper that stopped stripping: the assertion
     * below would then be satisfied only by deleting two dozen accurate
     * historical comments, which is the opposite of what it is for.
     */
    const mentions = trackedSources().filter((file) =>
      readFileSync(join(PACKAGE_ROOT, file), 'utf8').includes('mongoose'),
    );
    expect(mentions.length).toBeGreaterThan(5);
    expect(importersOf('mongoose').length).toBeLessThan(mentions.length);
  });

  it('has no importer and no direct dependency', () => {
    const importers = [
      ...new Set([...importersOf('mongoose'), ...importersOf('mongodb')]),
    ].sort();

    expect(
      importers,
      'a Mongo driver reintroduces a store this service does not have: no ' +
        'migration ledger covers it, no expiry sweep reaps it and no ' +
        'unique-constraint parity gate sees it.',
    ).toEqual([]);

    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    expect(declared).not.toHaveProperty('mongoose');
    expect(declared).not.toHaveProperty('mongodb');
  });
});
