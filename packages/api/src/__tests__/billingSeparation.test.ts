import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CREDIT_FUNDING_SOURCES } from '../domain/credit-funding.js';
import { allowanceKeyFor } from '../lib/plan-access.js';

/**
 * The line between an Alia PRODUCT entitlement and an Oxy FINANCIAL record —
 * epic #139 workstream 12, enforcing ADR 0005.
 *
 * That ADR's own Enforcement section lists four of these as *not yet enforced*.
 * This file is that enforcement, and every gate here answers the same question
 * about itself: **what would it report if the thing it measures were absent?**
 *
 *  - `cost_entries.cost_usd` is never a billing source (ADR 0005 §"Product price
 *    and margin are separate from provider upstream cost"). If the property
 *    stopped holding, a module would appear in BOTH censuses below and the
 *    disjointness assertion goes red.
 *  - the write half is deletable without touching the read half. If the read
 *    model acquired a financial dependency, its module closure would contain a
 *    financial module and the closure assertion goes red.
 *  - every plan, credit, subscription and transaction path is audited. If a
 *    writer or a caller appeared that `billing-paths.json` does not name, the
 *    set equality goes red — and so does a name it lists that no longer exists.
 *  - free and promotional usage is still cost-attributed. If the reservation
 *    stopped carrying a funding source, or the one live settlement stopped
 *    writing it, the source assertions go red.
 *
 * ## Why the TypeScript AST rather than grep
 *
 * This repository documents its own invariants in prose, at length, naming the
 * very identifiers these censuses count — `db/schema/billing.ts` contains the
 * words `cost_entries.cost_usd` and `addCredits` in comments, and a grep census
 * reports both files as violations. `grep` is also LINE-based, so a multi-line
 * `import {\n a,\n b\n}` matches nothing and reads as clean. Comments are trivia
 * to the parser and never appear as an identifier, and a multi-line import is
 * one node. The scanner is pinned by its own positive controls first, in the
 * same currency as the measurements.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const API_SRC = 'packages/api/src';

/** This file names every identifier it counts, so it excludes itself. */
const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));

const isTestFile = (f: string) => f.includes('/__tests__/') || f.endsWith('.test.ts');

/**
 * `git ls-files` rather than a directory walk: it reports the INDEX, so it
 * cannot disagree with what git tracks, and an untracked scratch file cannot
 * silently become part of a census.
 */
function trackedSources(prefix: string): string[] {
  return execFileSync('git', ['ls-files', '--', prefix], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && f !== SELF && existsSync(path.join(REPO_ROOT, f)));
}

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);

/** Every identifier and string literal in a file. Comments are trivia and absent. */
function symbols(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text);
    if (ts.isStringLiteralLike(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

interface NamedImport {
  readonly spec: string;
  readonly names: readonly string[];
}

/**
 * Every module a file names together with the bindings it takes from it.
 *
 * Static and awaited-dynamic both, because this package reaches for
 * `await import()` wherever a cycle would otherwise form — `gateway-client.ts`
 * imports the whole billing repository layer that way, and a census that saw
 * only static imports would report it clean.
 *
 * An `as` alias resolves back to the EXPORTED name: `seed-features.ts` takes
 * `seedPlanFeatures as insertSeedPlanFeatures`, and attributing that to the
 * local name would lose the caller.
 */
function namedImports(sf: ts.SourceFile): NamedImport[] {
  const out: NamedImport[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const bindings = n.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        out.push({
          spec: n.moduleSpecifier.text,
          names: bindings.elements.map((e) => (e.propertyName ?? e.name).text),
        });
      } else {
        out.push({ spec: n.moduleSpecifier.text, names: [] });
      }
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ spec: n.moduleSpecifier.text, names: [] });
    }
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (
          d.initializer &&
          ts.isAwaitExpression(d.initializer) &&
          ts.isCallExpression(d.initializer.expression) &&
          d.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          const arg = d.initializer.expression.arguments[0];
          if (arg && ts.isStringLiteralLike(arg)) {
            const names =
              ts.isObjectBindingPattern(d.name)
                ? d.name.elements
                    .map((e) =>
                      e.propertyName && ts.isIdentifier(e.propertyName)
                        ? e.propertyName.text
                        : ts.isIdentifier(e.name)
                          ? e.name.text
                          : '',
                    )
                    .filter((x) => x !== '')
                : [];
            out.push({ spec: arg.text, names });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every module a file names, including bare `import()` anywhere in an expression. */
function moduleSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** A relative specifier as a repo-relative `.ts` path, or `null` for a package. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(path.join(REPO_ROOT, fromFile)), spec).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return path.relative(REPO_ROOT, candidate);
  }
  return null;
}

/** Every module reachable from `entry` inside this package, `entry` included. */
function moduleClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const spec of moduleSpecifiers(parse(file))) {
      const resolved = resolveSpec(file, spec);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

// ===========================================================================
// The scanner's own positive controls
// ===========================================================================

/**
 * A census that reads nothing prints the same clean zero as a codebase with
 * nothing to find. Every form the gates below rely on occurs somewhere in this
 * package, so each is pinned against a literal buffer first — including the two
 * that decide whether a violation is visible at all: a comment must NOT count,
 * and a multi-line import MUST.
 */
describe('the scanner recognises every form these gates rely on', () => {
  const probe = (text: string) => ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);

  it('does not see an identifier that occurs only in a comment', () => {
    // The control that decides whether the cost censuses mean anything:
    // `db/schema/billing.ts` documents `cost_entries.cost_usd` in prose, and a
    // grep reports it as a reader of the column.
    expect(symbols(probe('// costUsd and spentUsd\n/** costUsd */\nconst a = 1;'))).not.toContain('costUsd');
    expect(symbols(probe('const costUsd = 1;'))).toContain('costUsd');
  });

  it('sees a multi-line named import, an alias, and an awaited dynamic one', () => {
    expect(namedImports(probe("import {\n  addCredits,\n  zeroCredits,\n} from './r.js';"))[0].names).toEqual([
      'addCredits',
      'zeroCredits',
    ]);
    // The alias resolves to the EXPORTED name, not the local one.
    expect(namedImports(probe("import { seedPlanFeatures as x } from './r.js';"))[0].names).toEqual([
      'seedPlanFeatures',
    ]);
    expect(namedImports(probe("const { insertTransaction } = await import('./r.js');"))[0]).toEqual({
      spec: './r.js',
      names: ['insertTransaction'],
    });
  });

  it('follows a dynamic import when walking a closure, not only a static one', () => {
    // Sorted, because the walker consumes a SET and the visit order is an
    // artefact of where the statements sit rather than something it promises.
    expect(
      moduleSpecifiers(probe("const m = await import('./dyn.js'); import './stat.js';")).sort(),
    ).toEqual(['./dyn.js', './stat.js']);
  });

  it('reads the real tree, and excludes only this file', () => {
    const tracked = trackedSources(API_SRC);
    expect(tracked.length).toBeGreaterThan(400);
    expect(tracked).toContain(`${API_SRC}/lib/plan-access.ts`);
    expect(tracked).not.toContain(SELF);
    // The exclusion removes exactly one file, so it cannot quietly grow into a
    // place to hide things.
    const unfiltered = execFileSync('git', ['ls-files', '--', API_SRC], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.ts') && existsSync(path.join(REPO_ROOT, f)));
    expect(unfiltered.length - tracked.length).toBe(1);
  });
});

// ===========================================================================
// The customer charge and the upstream cost share no column and no reader
// ===========================================================================

/**
 * ADR 0005: *"`cost_entries.cost_usd` is not a customer billing source, now or
 * later"* and *"Product price and margin are separate from provider upstream
 * cost"*. Epic #139 L438 and L474.
 *
 * Both are one structural property: **the set of modules that read an upstream
 * cost figure and the set that write a customer charge are DISJOINT.** Stated
 * that way it is checkable, and a violation is the single import that would
 * make a billing path able to read the estimate.
 */
describe('the customer charge and the upstream cost share no reader (#139 ws12)', () => {
  /**
   * The identifiers that ARE an upstream cost figure, in either spelling.
   *
   * `cost_entries.cost_usd` and `provider_keys.spent_usd` are the columns; the
   * rest are what an aggregate over them is called where it is returned, since a
   * module that never names the column but sums it is just as much a reader.
   */
  const UPSTREAM_COST_SYMBOLS = [
    'costUsd',
    'costUSD',
    'cost_usd',
    'spentUsd',
    'spent_usd',
    'totalSpent',
    'totalCost',
    'avgCostPer1kTokens',
  ] as const;

  /** The repositories that move a customer's balance or write their receipt. */
  const CHARGE_REPOSITORIES = ['userCreditsRepository', 'transactionRepository'] as const;

  /**
   * A module counts as reading upstream cost if it NAMES one of those figures,
   * OR if it imports the cost ledger's repository at all.
   *
   * The second clause is not redundant, and the mutation test is what showed it:
   * importing `selectCostEntries` and passing the rows on adds no cost
   * IDENTIFIER to the importing module, so a symbol census alone reports it
   * clean while the module has full access to the estimate. The whole subject
   * matter of that repository is `cost_entries`, so naming the module is exact
   * rather than a heuristic — unlike `providerKeyRepository`, which most of the
   * routing layer imports for reasons that have nothing to do with `spent_usd`,
   * and which the identifier census therefore covers instead.
   */
  const COST_LEDGER_MODULE = 'db/usage/costEntryRepository';

  const costReaders = (): string[] =>
    trackedSources(API_SRC)
      .filter((f) => !isTestFile(f))
      .filter((f) => {
        const sf = parse(f);
        const found = symbols(sf);
        return (
          UPSTREAM_COST_SYMBOLS.some((s) => found.has(s)) ||
          moduleSpecifiers(sf).some((spec) => spec.includes(COST_LEDGER_MODULE))
        );
      })
      .sort();

  const chargeWriters = (): string[] =>
    trackedSources(API_SRC)
      .filter((f) => !isTestFile(f))
      .filter((f) =>
        moduleSpecifiers(parse(f)).some((spec) => CHARGE_REPOSITORIES.some((r) => spec.includes(r))),
      )
      .sort();

  /**
   * Frozen, exactly, in both directions.
   *
   * A floor (`>= 1`) would be satisfied by a scanner that had stopped working,
   * and a superset check would let a new reader in silently. An entry that
   * DISAPPEARS fails too, so removing a reader has to be recorded here rather
   * than quietly narrowing what the disjointness below is about.
   */
  const COST_READERS = [
    // A schema declaration, not a runtime reader: provider_keys is frozen and
    // dormant through the rollback window, but its historical spent_usd column
    // remains physically present until the separately gated retirement release.
    `${API_SRC}/db/schema/providers.ts`,
    `${API_SRC}/db/schema/usage.ts`,
    `${API_SRC}/db/usage/costEntryRepository.ts`,
    `${API_SRC}/lib/cost-tracker.ts`,
  ];

  const CHARGE_WRITERS = [
    `${API_SRC}/lib/credit-anomaly.ts`,
    `${API_SRC}/lib/credits-manager.ts`,
    // The comp grant. It writes a charge-shaped record — a `subscription_payment`
    // transaction and a `credits_paid` movement — through the SAME dedup lock a
    // Stripe renewal uses, with `amount: 0` because no money moved.
    `${API_SRC}/lib/seed-comped-accounts.ts`,
    `${API_SRC}/lib/user-credits-helpers.ts`,
    `${API_SRC}/routes/billing.ts`,
    `${API_SRC}/routes/referrals.ts`,
  ];

  it('names every module that reads an upstream cost figure', () => {
    expect(costReaders()).toEqual(COST_READERS);
  });

  it('names every module that writes a customer charge', () => {
    expect(chargeWriters()).toEqual(CHARGE_WRITERS);
  });

  it('the two sets are disjoint, so no charging path can read the estimate', () => {
    const readers = new Set(costReaders());
    const overlap = chargeWriters().filter((f) => readers.has(f));
    expect(overlap, 'a customer-charging module reads an upstream cost figure').toEqual([]);
  });

  it('the disjointness check is capable of reporting an overlap', () => {
    // The positive control the assertion above cannot supply for itself: with
    // both sets empty, or a scanner that found nothing, the overlap is also
    // empty and the gate reads green while measuring nothing.
    const readers = new Set(['a.ts', 'b.ts']);
    expect(['b.ts', 'c.ts'].filter((f) => readers.has(f))).toEqual(['b.ts']);
  });

  it('the frozen lists are not empty, and each is what its name says', () => {
    // A vacuity floor for both lists, plus one membership fact per list that a
    // wholesale replacement would break.
    expect(COST_READERS.length).toBeGreaterThanOrEqual(4);
    expect(CHARGE_WRITERS.length).toBeGreaterThan(3);
    expect(COST_READERS).toContain(`${API_SRC}/lib/cost-tracker.ts`);
    expect(CHARGE_WRITERS).toContain(`${API_SRC}/routes/billing.ts`);
  });

  it('the schema still says the column is an estimate, in the place a reader looks', () => {
    // The prose half of ADR 0005's enforcement, which is not redundant with the
    // structural half: a developer reaching for this column reads the comment
    // long before they read a test.
    const usage = readFileSync(path.join(REPO_ROOT, API_SRC, 'db/schema/usage.ts'), 'utf8');
    // The block-comment margin and the wrapping both come out first: a literal
    // substring would otherwise be asserting where the line breaks fall.
    const prose = usage.replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ');
    expect(prose).toContain('it is a derived estimate');
    expect(prose).toContain('If per-user BILLING is ever taken from this table');
  });
});

// ===========================================================================
// The write half is deletable without touching the read half
// ===========================================================================

/**
 * ADR 0005: *"Alia keeps entitlements as a low-latency read model"*, and epic
 * #139 L472, *"Keep only the minimum Alia-side entitlement/read-model cache
 * needed for low-latency product decisions"*.
 *
 * The property that makes the cutover a deletion rather than a rewrite is
 * DIRECTIONAL: the write half may depend on the read model (`routes/billing.ts`
 * invalidates its cache) and the read model may not depend on the write half. So
 * the check walks the read model's whole module closure and asserts no financial
 * module is in it — which is the same statement as "delete those files and this
 * one still compiles".
 */
describe('the financial write half can be deleted without touching the read model (#139 ws12)', () => {
  const READ_MODEL = `${API_SRC}/lib/plan-access.ts`;

  /** The modules ADR 0005 moves to Oxy. Deleting these is the cutover. */
  const FINANCIAL_MODULES = [
    `${API_SRC}/db/billing/userCreditsRepository.ts`,
    `${API_SRC}/db/billing/transactionRepository.ts`,
    `${API_SRC}/lib/credits-manager.ts`,
    `${API_SRC}/lib/user-credits-helpers.ts`,
    `${API_SRC}/lib/stripe-prices.ts`,
    `${API_SRC}/routes/billing.ts`,
    `${API_SRC}/routes/credits.ts`,
  ];

  it('the read model reaches no financial module, however many hops away', () => {
    const closure = moduleClosure(READ_MODEL);
    const reached = FINANCIAL_MODULES.filter((m) => closure.has(m));
    expect(reached, 'the entitlement read model depends on the financial write half').toEqual([]);
  });

  it('the closure walker can find a financial module when one is there', () => {
    // The positive control, and it is the same walker over a different entry:
    // `routes/billing.ts` IS the write half, so its closure must contain the
    // modules the assertion above says the read model's does not. Without this,
    // a walker that returned an empty set would pass the gate above.
    const closure = moduleClosure(`${API_SRC}/routes/billing.ts`);
    expect(closure).toContain(`${API_SRC}/db/billing/userCreditsRepository.ts`);
    expect(closure).toContain(`${API_SRC}/db/billing/transactionRepository.ts`);
    expect(closure).toContain(`${API_SRC}/lib/user-credits-helpers.ts`);
  });

  it('the read model closure is real, and includes what it must', () => {
    // The vacuity floor: an empty or one-element closure would satisfy the
    // emptiness assertion above trivially.
    const closure = moduleClosure(READ_MODEL);
    expect(closure.size).toBeGreaterThan(20);
    expect(closure).toContain(`${API_SRC}/db/billing/subscriptionRepository.ts`);
    expect(closure).toContain(`${API_SRC}/lib/gateway-client.ts`);
  });

  it('the direction is the permitted one: the write half depends on the read model', () => {
    // Stated so a "fix" that cut the dependency the other way — deleting the
    // cache invalidation from the Stripe webhook — cannot look like progress.
    const billing = namedImports(parse(`${API_SRC}/routes/billing.ts`));
    const fromReadModel = billing.filter((i) => i.spec.includes('plan-access'));
    // A SET: the route takes `getUserEntitlements` twice, statically and again
    // through an awaited `import()` inside the voice-usage handler.
    expect([...new Set(fromReadModel.flatMap((i) => i.names))].sort()).toEqual([
      'getUserEntitlements',
      'invalidateEntitlementsCache',
    ]);
  });

  it('the read model takes only READ functions from the subscription repository', () => {
    // The closure check cannot see this: `subscriptionRepository.ts` holds both
    // halves, so the module being in the closure is correct and the bindings are
    // what decide whether the read model can write.
    const taken = namedImports(parse(READ_MODEL))
      .filter((i) => i.spec.includes('subscriptionRepository'))
      .flatMap((i) => i.names)
      .filter((n) => n !== 'SubscriptionRow')
      .sort();
    expect(taken).toEqual(['findActiveSubscriptions']);
  });

  it('the read model synthesises no balance into the contract shape', () => {
    // `payAsYouGo` carries MONEY and `user_credits` carries a COUNT. The
    // behavioural half is in `entitlements.test.ts`; this is the structural one,
    // because a `null` literal is one edit away from a balance read.
    const found = symbols(parse(READ_MODEL));
    for (const forbidden of ['userCredits', 'creditsFree', 'creditsPaid', 'getUserCredits']) {
      expect(found, `the read model reads ${forbidden}`).not.toContain(forbidden);
    }
    // The floor: the scanner is reading the right file and can see its symbols.
    expect(found).toContain('getUserEntitlements');
    expect(found).toContain('payAsYouGo');
  });
});

// ===========================================================================
// Every plan, credit, subscription and transaction path is audited
// ===========================================================================

/**
 * Epic #139 L468, *"Audit every Alia plan, credit, subscription and transaction
 * path"*.
 *
 * `docs/migration/inventories/billing-paths.json` is the audit. This re-derives
 * it from source and compares by SET EQUALITY in both directions, so the audit
 * cannot go stale in either failure mode: a new writer nobody classified, or a
 * name the audit still claims after the function has gone.
 */
describe('the billing path audit matches the tree it describes (#139 ws12)', () => {
  interface AuditWriter {
    readonly fn: string;
    readonly module: string;
    readonly callers: readonly string[];
    readonly classification: string;
    readonly reachable: boolean;
  }
  interface Audit {
    readonly tables: ReadonlyArray<{ readonly table: string; readonly writers: readonly AuditWriter[] }>;
    readonly balanceSurfaces: { readonly modules: readonly string[] };
  }

  const audit: Audit = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'docs/migration/inventories/billing-paths.json'), 'utf8'),
  );

  /** The drizzle table objects the seven billing tables are declared as. */
  const BILLING_TABLES = [
    'plans',
    'features',
    'planFeatures',
    'creditPackages',
    'subscriptions',
    'transactions',
    'userCredits',
  ] as const;

  /** Every exported function under `db/billing/` whose body reaches a write builder. */
  function derivedWriters(): { fn: string; module: string }[] {
    const out: { fn: string; module: string }[] = [];
    for (const file of trackedSources(`${API_SRC}/db/billing`).filter((f) => !isTestFile(f))) {
      const sf = parse(file);
      const visit = (n: ts.Node): void => {
        if (
          ts.isFunctionDeclaration(n) &&
          n.name &&
          n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          let writes = false;
          const inner = (m: ts.Node): void => {
            if (
              ts.isCallExpression(m) &&
              ts.isPropertyAccessExpression(m.expression) &&
              ['insert', 'update', 'delete'].includes(m.expression.name.text)
            ) {
              const arg = m.arguments[0];
              if (arg && ts.isIdentifier(arg) && (BILLING_TABLES as readonly string[]).includes(arg.text)) {
                writes = true;
              }
            }
            ts.forEachChild(m, inner);
          };
          inner(n);
          if (writes) out.push({ fn: n.name.text, module: path.relative(API_SRC, file) });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return out.sort((a, b) => a.fn.localeCompare(b.fn));
  }

  /** Every non-test module outside `db/billing/` importing one of those writers. */
  function derivedCallers(writerNames: ReadonlySet<string>): Map<string, string[]> {
    const byFn = new Map<string, string[]>([...writerNames].map((n) => [n, []]));
    for (const file of trackedSources(API_SRC)) {
      if (isTestFile(file) || file.startsWith(`${API_SRC}/db/billing/`)) continue;
      for (const { spec, names } of namedImports(parse(file))) {
        if (!spec.includes('/db/billing/')) continue;
        for (const name of names) byFn.get(name)?.push(path.relative(API_SRC, file));
      }
    }
    for (const [fn, files] of byFn) byFn.set(fn, [...new Set(files)].sort());
    return byFn;
  }

  it('the writer scanner separates a writing export from a reading one', () => {
    // The positive control, over the real tree rather than a buffer: two
    // functions in one file, one of which writes. If the scanner degraded to
    // "every exported function", `findUserCredits` would appear.
    const names = derivedWriters().map((w) => w.fn);
    expect(names).toContain('insertTransaction');
    expect(names).not.toContain('findUserCredits');
    expect(names).not.toContain('selectTransactionsForUser');
  });

  it('the audit names exactly the writers the tree has, and no others', () => {
    const derived = derivedWriters();
    const audited = audit.tables
      .flatMap((t) => t.writers)
      .map((w) => ({ fn: w.fn, module: w.module }))
      .sort((a, b) => a.fn.localeCompare(b.fn));

    expect(audited).toEqual(derived);
    // The floor. An audit and a scanner that both produced nothing would satisfy
    // the equality above.
    //
    // 26 -> 27 in #139 ws14: `setPlanModelIds`, the audited writer of
    // `plans.model_ids`. Read off `derived`, which is the scan of the tree,
    // rather than incremented — the number this file exists to protect is a
    // measurement, and arithmetic on it is how a plausible wrong one lands.
    expect(derived.length).toBe(27);
    expect(audit.tables.length).toBe(7);
  });

  it('the audit names exactly the callers each writer has', () => {
    const audited = audit.tables.flatMap((t) => t.writers);
    const derived = derivedCallers(new Set(audited.map((w) => w.fn)));

    for (const writer of audited) {
      expect([...writer.callers].sort(), `${writer.fn}'s callers moved`).toEqual(derived.get(writer.fn));
      // `reachable` is the audit's own summary of the same fact, so it cannot
      // drift from the list beside it.
      expect(writer.reachable, `${writer.fn}'s reachability`).toBe(writer.callers.length > 0);
    }

    // Both directions of the vacuity floor: some writers have callers and some
    // have none, so neither an empty caller map nor a scanner matching
    // everything would pass.
    expect(audited.filter((w) => w.reachable).length).toBeGreaterThan(0);
    expect(audited.filter((w) => !w.reachable).length).toBe(12);
  });

  it('every writer is classified, from the vocabulary the audit declares', () => {
    const audited = audit.tables.flatMap((t) => t.writers);
    for (const writer of audited) {
      expect(['CATALOGUE', 'ENTITLEMENT', 'FINANCIAL', 'SPLIT']).toContain(writer.classification);
    }
    // Every classification is actually used — a vocabulary with a dead member is
    // a category nobody applied, which is how a path gets filed under the wrong
    // half without anybody choosing to.
    const used = new Set(audited.map((w) => w.classification));
    expect([...used].sort()).toEqual(['CATALOGUE', 'ENTITLEMENT', 'FINANCIAL', 'SPLIT']);
  });

  it('names every surface that reaches the balance row through the helper', () => {
    // The writer census sees ONE caller for `getOrCreateUserCredits` — the
    // helper — and the blast radius of the cutover is what is behind it. Listed
    // and asserted separately for that reason.
    const HELPERS = ['getOrCreateUserCredits', 'getRefreshedUserCredits'];
    const derived = trackedSources(API_SRC)
      .filter((f) => !isTestFile(f) && f !== `${API_SRC}/lib/user-credits-helpers.ts`)
      .filter((f) =>
        namedImports(parse(f)).some(
          (i) => i.spec.includes('user-credits-helpers') && i.names.some((n) => HELPERS.includes(n)),
        ),
      )
      .map((f) => path.relative(API_SRC, f))
      .sort();

    expect(derived).toEqual([...audit.balanceSurfaces.modules].sort());
    // Hosted provider voice/image/audio surfaces are absent after cutover; this
    // count is read from the surviving product tree rather than preserved as a
    // compatibility floor for deleted modules.
    expect(derived.length).toBe(11);
  });
});

// ===========================================================================
// Free and promotional usage is still cost-attributed
// ===========================================================================

/**
 * Epic #139 L475 and ADR 0005 §*"Free and promotional usage is still
 * cost-attributed internally"*.
 *
 * ## What the audit got wrong, recorded here because a gate is where it will be
 * ## re-read
 *
 * `epic-139-status.json` L475 states that free usage "does write a `cost_entries`
 * row, so cost attribution exists". It does not. `recordCost` has **no caller
 * anywhere in this package** — `cost-tracker.ts` says so in its own file comment
 * and the census below re-derives it — so the token-metered paths produce no
 * cost record at all. The last assertion in this block pins that zero, so the
 * day somebody wires the ledger up they are sent back here.
 *
 * The one settlement that DOES write a cost record is the voice session, and it
 * is the one place a `CreditReservation` and the serving provider coexist. That
 * is the live entrypoint; `cost_entries` carries the same column ready for the
 * token paths.
 */
describe('a cost record says which balance funded it (#139 ws12)', () => {
  it('the funding source is a closed set both tables render a CHECK from', () => {
    expect([...CREDIT_FUNDING_SOURCES]).toEqual(['free_allowance', 'paid_balance']);

    const schema = readFileSync(path.join(REPO_ROOT, API_SRC, 'db/schema/usage.ts'), 'utf8');
    for (const table of ['cost_entries', 'voice_call_usage']) {
      expect(schema, `${table} has no funding-source CHECK`).toContain(`${table}_grant_kind_check`);
    }
    // Rendered from the tuple, not from a retyped list beside it.
    const usage = symbols(parse(`${API_SRC}/db/schema/usage.ts`));
    expect(usage).toContain('CREDIT_FUNDING_SOURCES');
    expect(usage).not.toContain('free_allowance');
  });

  it('the reservation carries it, decided from the balance the spend returned', () => {
    const manager = parse(`${API_SRC}/lib/credits-manager.ts`);
    const found = symbols(manager);
    expect(found).toContain('grantKind');

    // The DECISION, not merely the field: a `grantKind` hardcoded to one value
    // would satisfy every structural check and label every turn identically.
    //
    // The predicate now lives in `domain/credit-funding.ts` beside the two
    // imprecisions it carries, because a SECOND caller reaches the same verdict
    // off stored columns — `agentSessionRepository` rebuilds the funding source
    // of a reservation a queued session is holding, and a copy of the
    // expression there would be free to disagree with this one. So this asserts
    // the decision at its owner AND that the reservation is built from it.
    const funding = parse(`${API_SRC}/domain/credit-funding.ts`).getFullText();
    expect(funding).toMatch(
      /return freeCreditsRemaining > 0 \? 'free_allowance' : 'paid_balance';/,
    );
    expect(manager.getFullText()).toContain(
      'const grantKind: CreditFundingSource = fundingSourceOf(reserveResult.creditsFree);',
    );
    expect(parse(`${API_SRC}/db/agents/agentSessionRepository.ts`).getFullText()).toContain(
      'grantKind: fundingSourceOf(initialFreeCredits)',
    );
  });

  it('the token-metered ledger still has no writer, and this is the count that says so', () => {
    // Not an aspiration: a measurement, frozen. `recordCost` is the only writer
    // of `cost_entries`, and outside its own module and its test nothing calls
    // it — so ADR 0005's cost attribution does NOT yet hold for chat, images or
    // audio. Wiring it up turns this red, which is the point.
    const callers = trackedSources(API_SRC)
      .filter((f) => !isTestFile(f) && f !== `${API_SRC}/lib/cost-tracker.ts`)
      .filter((f) => symbols(parse(f)).has('recordCost'))
      .sort();
    expect(callers, 'recordCost gained a caller — update this gate and the audit').toEqual([]);

    // The positive control: the same scan finds the function where it IS.
    expect(symbols(parse(`${API_SRC}/lib/cost-tracker.ts`))).toContain('recordCost');
    // And `recordCost` really does take a funding source, so the day it is wired
    // in the attribution comes with it rather than being added afterwards.
    expect(readFileSync(path.join(REPO_ROOT, API_SRC, 'lib/cost-tracker.ts'), 'utf8')).toContain(
      'grantKind: CreditFundingSource | null,',
    );
  });
});

// ===========================================================================
// The allowance key namespace
// ===========================================================================

/**
 * The contract's `planAllowanceSchema.key` is a machine name with no hyphen and
 * every Alia `feature_id` is kebab-case, so the read model maps one to the
 * other. A feature id that cannot be mapped is DROPPED from the contract
 * allowances rather than throwing — throwing would take the model gate down with
 * it — which is exactly the kind of silent loss that needs a gate rather than a
 * comment.
 */
describe('every seeded feature id has a contract allowance key (#139 ws12)', () => {
  /**
   * Read off the seed's SOURCE rather than imported.
   *
   * Importing `seed-features.ts` would pull the whole repository layer into this
   * file for a list of string literals, and the ids are what a `featureId:`
   * property is initialised FROM — which is the same thing the seed writes.
   */
  function seededFeatureIds(): string[] {
    const sf = parse(`${API_SRC}/internal/providers/lib/seed-features.ts`);
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isPropertyAssignment(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === 'featureId' &&
        ts.isStringLiteralLike(n.initializer)
      ) {
        out.push(n.initializer.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return [...new Set(out)];
  }

  it('maps every seeded feature id, injectively', () => {
    const ids = seededFeatureIds();
    expect(ids.length).toBeGreaterThan(30);

    const keys = ids.map((id) => allowanceKeyFor(id));
    const unmappable = ids.filter((_, i) => keys[i] === null);
    expect(unmappable, 'a seeded feature has no contract allowance key').toEqual([]);
    // Injective: two feature ids collapsing onto one key would silently merge
    // two allowances, and the larger one would win.
    expect(new Set(keys).size).toBe(ids.length);
  });

  it('the mapper can refuse, so the assertion above is not vacuous', () => {
    // Uppercase, a leading digit and an illegal character are all outside the
    // contract's pattern; a mapper that returned its input would pass the test
    // above and this one would catch it.
    expect(allowanceKeyFor('Voice-Minutes')).toBeNull();
    expect(allowanceKeyFor('1-minute')).toBeNull();
    expect(allowanceKeyFor('voice minutes')).toBeNull();
    expect(allowanceKeyFor('voice-minutes')).toBe('voice_minutes');
  });
});
