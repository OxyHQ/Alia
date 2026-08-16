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
 *     whether a request may use a model at all. This is the one that looks like
 *     a runtime configuration surface, and the finding is that it is not: the
 *     list is code-managed and re-asserted from code on every boot, so editing
 *     the row does not survive the next deploy.
 *
 * So the audit trail for all three is git, and the property worth guarding is
 * the one that makes that TRUE — that each remains code-managed. Each assertion
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

describe('plan model access is code-managed, so its audit trail is git (#139 ws15)', () => {
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

  it('boot re-asserts the model list from code, so a row edit does not survive a deploy', () => {
    // The claim that makes "the audit trail is git" true rather than hopeful. A
    // hand-edited `plans.modelIds` is overwritten by the next start-up, so the
    // row is a cache of the code and never a source of truth.
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
