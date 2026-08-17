import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Configuration that changes model or routing behaviour — epic #139 workstream
 * 15, *"Add audit logs for configuration changes that affect model/routing
 * behavior"*.
 *
 * ## The answer is that there is nothing to audit, and this file is the evidence
 *
 * A checkbox can be satisfied by absence, but only if the absence is measured.
 * `routes/__tests__/inference-boundary.test.ts` already holds one half of that
 * measurement: every writer in the four PROVIDER repositories (`alia_models`,
 * `model_configs`, `provider_keys`, `external_models`) is mapped to its caller,
 * nine have no runtime caller at all, and the rest are boot seeding, a script,
 * or automatic key health.
 *
 * This file holds the other half — the three routing-configuration surfaces that
 * map does not reach, because they are not provider repositories:
 *
 *  1. **The routing presets.** `ROUTING_PRESETS` is a `const` array. No
 *     repository, no table, no route.
 *  2. **The alias set.** `ALIA_MODELS` is a `const` record. The `alia_models`
 *     table contributes one display flag (`isLegacy`) and nothing a request
 *     routes on.
 *  3. **Which models a plan grants.** `plans.modelIds` IS a database column, and
 *     it is the input to `lib/plan-access.ts`, which is the gate that decides
 *     whether a request may use a model at all.
 *
 *     This file originally claimed the row was code-managed because boot
 *     re-asserts it. **That was wrong, and the correction matters more than the
 *     original claim did.** `seedPlans()` is called from exactly one place —
 *     `runStartupSeed()` in `internal/providers/lib/seed-model-configs.ts:267` —
 *     and `runStartupSeed()` has zero callers repo-wide. `src/index.ts:374-376`
 *     seeds skills, suggestions and bots, and nothing else. So nothing re-asserts
 *     `plans.modelIds`, a hand-edited row survives every deploy, and this IS a
 *     runtime configuration surface that decides model access with no audit
 *     record of who changed it.
 *
 * So the audit trail is git for (1) and (2) only. (3) is a real gap, and the
 * epic's "add audit logs for configuration changes that affect model/routing
 * behavior" is NOT satisfied by absence — it is unsatisfied. Each assertion
 * below therefore says what would make it false, and would fail at exactly the
 * moment somebody built the runtime surface the checkbox is about, which is when
 * the audit log becomes a real requirement rather than a note.
 *
 * ## What is deliberately NOT claimed
 *
 * That nothing anywhere can change routing. Environment and deployment can:
 * `GATEWAY_API_URL` plus `SERVICE_SECRET` switch `lib/gateway-client.ts` between
 * local and remote (`AGENTS.md`), and provider keys are SSM parameters. Those
 * are edited in `oxy-infra`, audited by its git history and by CloudTrail, and
 * an audit log written by this process could not see them anyway.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const API_SRC = path.join(REPO_ROOT, 'packages/api/src');

/** Source with comments stripped, so a census cannot read this repo's prose. */
function code(relative: string): string {
  const text = readFileSync(path.join(API_SRC, relative), 'utf8');
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      ranges.push([comment.pos, comment.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

function sourceFiles(pathspec: string): string[] {
  return execFileSync('git', ['ls-files', '--', pathspec], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/'))
    .map((file) => path.relative(API_SRC, path.join(REPO_ROOT, file)));
}

/** Files whose CODE calls `name(`. Excludes the file that declares it. */
function callersOf(name: string, exclude: readonly string[]): string[] {
  return sourceFiles('packages/api/src')
    .filter((relative) => !exclude.some((prefix) => relative.startsWith(prefix)))
    .filter((relative) => new RegExp(`\\b${name}\\s*\\(`).test(code(relative)))
    .sort();
}

/* -------------------------------------------------------------------------- */
/*  1 and 2: presets and aliases are code                                      */
/* -------------------------------------------------------------------------- */

describe('the routing presets are code, not a row (#139 ws15)', () => {
  it('are a frozen literal with no table behind them', () => {
    const presets = code('lib/routing/presets.ts');
    // The floor: the file was read and holds the table.
    expect(presets).toContain('export const ROUTING_PRESETS');
    expect([...presets.matchAll(/id: 'profile:/g)].length).toBeGreaterThanOrEqual(12);

    // No database, in either direction: it neither reads a repository nor is
    // written by one. The first line a runtime preset editor would add is one of
    // these, and it would land here.
    expect(presets).not.toContain('getDb');
    expect(presets).not.toContain('Repository');
    expect(presets).not.toContain('pgTable');

    // And nothing writes the exported binding. A preset changes by editing this
    // file, which is a commit.
    expect(presets).not.toMatch(/ROUTING_PRESETS\s*(\[|\.push|=[^=])/);
  });

  it('no repository or route names a routing preset', () => {
    const offenders = sourceFiles('packages/api/src')
      .filter((relative) => relative.startsWith('db/') || relative.startsWith('routes/'))
      .filter((relative) => code(relative).includes('ROUTING_PRESETS'));
    expect(offenders).toEqual([]);

    // The control: the same scan DOES find the identifier where it lives, so
    // the empty list is absence and not a filter that rejects everything.
    expect(
      sourceFiles('packages/api/src').filter((relative) => code(relative).includes('ROUTING_PRESETS')),
    ).toContain('lib/routing/presets.ts');
  });

  it('so is the product configuration built on top of them (#139 ws4)', () => {
    // `lib/product-modes.ts` arrived after this census and is a configuration
    // surface of exactly the kind it counts: `PRODUCT_MODES` decides which
    // modes exist and `OFFERED_PROFILES` decides what a picker offers. Both are
    // `const` in a committed file, so the audit trail is git — and this is the
    // assertion that goes red the moment somebody puts either behind a table,
    // which is when the epic's audit-log checkbox becomes a real requirement
    // rather than a note.
    const modes = code('lib/product-modes.ts');
    expect(modes).toContain('export const PRODUCT_MODES');
    expect(modes).toContain('export const OFFERED_PROFILES');
    expect([...modes.matchAll(/id: 'mode:/g)].length).toBeGreaterThanOrEqual(6);

    expect(modes).not.toContain('getDb');
    expect(modes).not.toContain('Repository');
    expect(modes).not.toContain('pgTable');
    expect(modes).not.toMatch(/PRODUCT_MODES\s*(\[|\.push|=[^=])/);
    expect(modes).not.toMatch(/OFFERED_PROFILES\s*(\[|\.push|=[^=])/);

    // And no route or repository writes it either. `routes/catalogue.ts` READS
    // `PRODUCT_MODES` to serialize it, which is the point of it; what would be
    // new is a route naming the visibility list, because the only reason to do
    // that is to change it.
    const offenders = sourceFiles('packages/api/src')
      .filter((relative) => relative.startsWith('db/') || relative.startsWith('routes/'))
      .filter((relative) => code(relative).includes('OFFERED_PROFILES'));
    expect(offenders).toEqual([]);
    // The control: the same scan finds the identifier where it lives.
    expect(
      sourceFiles('packages/api/src').filter((relative) => code(relative).includes('OFFERED_PROFILES')),
    ).toContain('lib/product-modes.ts');
  });

  it('the alias set is a literal, and the table behind it carries one display flag', () => {
    const aliases = code('internal/providers/lib/alia-models.ts');
    expect(aliases).toMatch(/export const ALIA_MODELS: Record<string, AliaModel> = \{/);
    expect([...aliases.matchAll(/creditMultiplier:/g)].length).toBeGreaterThanOrEqual(12);

    // The database is read for exactly one field, and it is not one a request
    // routes on — `isLegacy` decides whether a picker greys an entry out.
    expect(aliases).toContain('listAliaModels(getDb())');
    expect(aliases).toMatch(/legacyMap\.set\(doc\.aliasModelId, doc\.isLegacy\)/);
    // Nothing else is taken from the row. A second `doc.` read here would mean
    // the catalogue had started living in the table.
    expect([...aliases.matchAll(/\bdoc\.[a-zA-Z]+/g)].map((m) => m[0]).sort()).toEqual([
      'doc.aliasModelId',
      'doc.isLegacy',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  3: which models a plan grants                                              */
/* -------------------------------------------------------------------------- */

describe('plan model access is an UNAUDITED database row (#139 ws15)', () => {
  /**
   * Every writer of `plans` and `plan_features`, and its runtime caller.
   *
   * Exact equality, and the empty list is the interesting entry: `insertPlan`,
   * `deletePlanByPlanId`, `upsertPlanFeature` and `deletePlanFeature` are
   * reachable code with nobody calling them. They are the writers a future admin
   * route would reach for, so a caller appearing is the signal.
   */
  const PLAN_WRITERS: Readonly<Record<string, readonly string[]>> = {
    insertPlan: [],
    deletePlanByPlanId: [],
    upsertPlanFeature: [],
    deletePlanFeature: [],
    // Boot seeding: runs from the process's own start-up, not from a request.
    seedPlan: ['internal/providers/lib/seed-plans.ts'],
    seedPlanFeatures: [
      'internal/providers/lib/seed-features.ts',
      'internal/providers/lib/seed-model-configs.ts',
    ],
    // The one runtime writer, and the next test is about what it may write.
    updatePlanByPlanId: ['lib/gateway-client.ts'],
  };

  it('is exactly the writers this map accounts for', () => {
    const declared = [
      ...code('db/billing/planRepository.ts').matchAll(
        /export async function ((?:insert|update|delete|seed|upsert)[A-Za-z0-9_]*)/g,
      ),
      ...code('db/billing/planFeatureRepository.ts').matchAll(
        /export async function ((?:insert|update|delete|seed|upsert)[A-Za-z0-9_]*)/g,
      ),
    ].map((match) => match[1]);

    // The floor before the equality: the repositories were read.
    expect(declared.length).toBeGreaterThanOrEqual(7);
    expect(declared).toContain('seedPlan');
    expect([...declared].sort()).toEqual(Object.keys(PLAN_WRITERS).sort());
  });

  it('no writer has a caller its map does not name', () => {
    for (const [writer, expected] of Object.entries(PLAN_WRITERS)) {
      expect(callersOf(writer, ['db/billing/']), `${writer} changed callers`).toEqual([...expected].sort());
    }
    // The control: the census can see a caller that is there, and does not count
    // a mention in prose. `seed-plans.ts` calls `seedPlan`; `db/schema/billing.ts`
    // names it in a comment and must not be counted.
    expect(callersOf('seedPlan', ['db/billing/'])).toEqual(['internal/providers/lib/seed-plans.ts']);
    expect(readFileSync(path.join(API_SRC, 'db/schema/billing.ts'), 'utf8')).toContain('seed-plans.ts');
  });

  it('the one runtime writer cannot touch model access', () => {
    // `updatePlanByPlanId` has a caller, so what makes it safe is its ARGUMENT
    // TYPE at that caller: three Stripe identifier fields, none of which is
    // `modelIds`. Widening this signature is the change that would open a
    // request-driven path to model-access configuration.
    const client = code('lib/gateway-client.ts');
    expect(client).toMatch(
      /export async function updatePlan\(\s*planId: string,\s*updates: \{ stripeProductId\?: string; stripeMonthlyPriceId\?: string; stripeAnnualPriceId\?: string \},/,
    );
    expect(client).toContain('updatePlanByPlanId(getDb(), planId, updates)');

    // And its only caller writes Stripe price ids, not a model list.
    const prices = code('lib/stripe-prices.ts');
    expect(prices).toContain('updatePlan(plan.planId, { stripeProductId: product.id })');
    expect(prices).not.toContain('modelIds');
    expect(callersOf('updatePlan', ['db/billing/', 'lib/gateway-client.ts'])).toEqual([
      'lib/stripe-prices.ts',
    ]);
  });

  it('the plan seeder would re-assert the model list, but NOTHING RUNS IT', () => {
    // Reads as the guard that makes "the audit trail is git" true. It is not:
    // the seeder it describes is never invoked, so `plans.modelIds` is a source
    // of truth in the database rather than a cache of the code, and a hand edit
    // survives every deploy unrecorded.
    //
    // The assertion below is kept anyway, because it is the precondition for the
    // fix: whoever wires `runStartupSeed()` back up needs the seeder to
    // re-assert rather than skip. Until then this test documents a GAP, and the
    // assertion that it is a gap is the one immediately after it.
    //
    // The failure to watch for is the tidy-looking one: `onConflictDoNothing`,
    // or dropping `modelIds` from the `set`. Either makes the DATABASE the
    // authority for which models a plan grants, with no writer requiring
    // authentication and no record of who changed it — which is precisely the
    // configuration change this checkbox asks to be audited.
    const repository = code('db/billing/planRepository.ts');
    expect(repository).toMatch(
      /export async function seedPlan\([\s\S]{0,400}?onConflictDoUpdate\(\{[\s\S]{0,200}?set: \{ modelIds: values\.modelIds \?\? \[\] \},/,
    );
    expect(repository).not.toContain('onConflictDoNothing');

    // And the values it re-asserts come from a source file, not from a query.
    const seed = code('internal/providers/lib/seed-plans.ts');
    expect(seed).toMatch(/modelIds: FREE_MODEL_IDS/);
    expect([...seed.matchAll(/modelIds:/g)].length).toBeGreaterThanOrEqual(7);
    expect(seed).not.toContain('req.body');
  });

  it('the seeder has no caller, which is why this is a GAP and not an absence', () => {
    // Turns the finding above into a guard. `seedPlans()` is reached only from
    // `runStartupSeed()`, and `runStartupSeed()` is reached from nowhere — so
    // `plans.modelIds` is unaudited runtime configuration today.
    //
    // This goes RED the moment somebody wires the seeder back up, which is
    // exactly when a reader should return and re-decide whether the epic's audit
    // checkbox has become satisfiable by absence after all. Failing on the FIX is
    // deliberate: the alternative is a comment nobody re-reads.
    const api = sourceFiles('packages/api/src');

    // Vacuity floor and positive control: the scan must see a real tree, and it
    // must be able to find a boot seeder that IS called, or its zero below means
    // the scan is broken rather than that the caller is missing.
    expect(api.length).toBeGreaterThan(200);
    const entrypoint = code('index.ts');
    expect(entrypoint).toContain('seedSkills()');

    const callers = api.filter(
      (f) => !f.includes('__tests__') && !f.endsWith('seed-model-configs.ts') && code(f).includes('runStartupSeed'),
    );
    expect(callers).toEqual([]);

    // And the entrypoint seeds only the three it actually seeds.
    expect(entrypoint).not.toContain('runStartupSeed');
    expect(entrypoint).not.toContain('seedPlans');
  });

  it('no route writes plan or model configuration', () => {
    // The other direction: a new admin surface arrives as a ROUTE more often
    // than as a caller of an existing writer.
    const routes = sourceFiles('packages/api/src/routes');
    expect(routes.length).toBeGreaterThan(20);

    const forbidden =
      /\b(insertPlan|deletePlanByPlanId|upsertPlanFeature|deletePlanFeature|seedPlan|seedPlanFeatures)\s*\(/;
    expect(routes.filter((relative) => forbidden.test(code(relative)))).toEqual([]);

    // The control: the same predicate finds the writer where it is called.
    expect(forbidden.test(code('internal/providers/lib/seed-plans.ts'))).toBe(true);
  });
});
