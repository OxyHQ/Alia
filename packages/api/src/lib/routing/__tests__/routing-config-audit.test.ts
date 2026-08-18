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

describe('plan model access is an AUDITED database row (#139 ws14/ws15)', () => {
  /**
   * Every writer of `plans` and `plan_features`, its runtime caller, and which
   * of three categories it is in.
   *
   * This block read *"plan model access is an UNAUDITED database row"* and its
   * assertions pinned that state: the seeder had no caller, `plans.model_ids`
   * was a hand-editable row nothing re-asserted and nothing recorded, and the
   * epic's audit checkbox was unsatisfied. #139 workstream 14 changed the
   * design, so the assertions are INVERTED rather than deleted — the value that
   * used to be the pass is now the failure, which is what puts a design change
   * on the record instead of quietly removing the evidence of the old one.
   *
   * The verb list is wider than it was. It matched
   * `insert|update|delete|seed|upsert` and would have skipped `setPlanModelIds`
   * entirely — a writer a name-based census cannot see is the exact failure
   * #167 found twice in the provider repositories (`rotateProviderKey`,
   * `replaceProviderMappings`). A census that misses the writer this file is
   * about would have passed while measuring nothing.
   */
  const AUDITED = 'audited' as const;
  const BOOT = 'boot' as const;
  const UNCALLED = 'uncalled' as const;

  const PLAN_WRITERS: Readonly<Record<string, { category: string; callers: readonly string[] }>> = {
    insertPlan: { category: UNCALLED, callers: [] },
    deletePlanByPlanId: { category: UNCALLED, callers: [] },
    upsertPlanFeature: { category: UNCALLED, callers: [] },
    deletePlanFeature: { category: UNCALLED, callers: [] },
    // Deploy seeding. It RUNS — `scripts/seed.ts` is issued as a one-shot after
    // every rollout — and it is INSERT-only, which is the pair of facts that
    // makes the audited writer below meaningful rather than a change the next
    // deploy undoes. It said "boot seeding" and named `src/index.ts` until
    // 2026-08-18; that call sat behind a Mongo connection that never resolves,
    // so it ran never.
    seedPlan: { category: BOOT, callers: ['lib/seed-plans.ts'] },
    seedPlanFeatures: {
      category: BOOT,
      callers: ['internal/providers/lib/seed-features.ts'],
    },
    // The Stripe writer. Its safety is its ARGUMENT TYPE, asserted below.
    updatePlanByPlanId: { category: AUDITED, callers: ['lib/gateway-client.ts'] },
    // The one that made this block's title change. A route calls it, it emits a
    // record through `lib/security/config-audit.ts`, and its actor is required.
    setPlanModelIds: { category: AUDITED, callers: ['routes/internal.ts'] },
  };

  it('is exactly the writers this map accounts for', () => {
    const declared = [
      ...code('db/billing/planRepository.ts').matchAll(
        /export async function ((?:insert|update|delete|seed|upsert|set|replace|reset|mark|rotate)[A-Za-z0-9_]*)/g,
      ),
      ...code('db/billing/planFeatureRepository.ts').matchAll(
        /export async function ((?:insert|update|delete|seed|upsert|set|replace|reset|mark|rotate)[A-Za-z0-9_]*)/g,
      ),
    ].map((match) => match[1]);

    // The floor before the equality: the repositories were read.
    expect(declared.length).toBeGreaterThanOrEqual(8);
    expect(declared).toContain('seedPlan');
    // The control for the WIDENED verb list. Under the old pattern this name
    // was invisible, so this assertion is the one that proves the census can
    // now see the writer the rest of this block is about.
    expect(declared).toContain('setPlanModelIds');
    expect([...declared].sort()).toEqual(Object.keys(PLAN_WRITERS).sort());

    // Every writer is in one of the three categories, and each is populated —
    // a category that emptied would make its own assertions vacuous.
    const categories = Object.values(PLAN_WRITERS).map((w) => w.category);
    expect(new Set(categories)).toEqual(new Set([AUDITED, BOOT, UNCALLED]));
  });

  it('no writer has a caller its map does not name', () => {
    for (const [writer, { callers }] of Object.entries(PLAN_WRITERS)) {
      expect(callersOf(writer, ['db/billing/']), `${writer} changed callers`).toEqual([...callers].sort());
    }
    // The control: the census can see a caller that is there, and does not count
    // a mention in prose. `lib/seed-plans.ts` calls `seedPlan`;
    // `db/schema/billing.ts` names it in a comment and must not be counted.
    expect(callersOf('seedPlan', ['db/billing/'])).toEqual(['lib/seed-plans.ts']);
    expect(readFileSync(path.join(API_SRC, 'db/schema/billing.ts'), 'utf8')).toContain('seed-plans.ts');
  });

  it('every writer a ROUTE calls is audited, and emits a record', () => {
    // The rule the epic's checkbox actually asks for, stated as a rule rather
    // than as a list: a request-driven configuration change leaves a record.
    // A new route calling an unaudited writer fails here, and the fix is the
    // record — not a new line in the map.
    const routes = sourceFiles('packages/api/src/routes');
    expect(routes.length).toBeGreaterThan(20);

    const repository = code('db/billing/planRepository.ts');
    let checked = 0;
    for (const [writer, { category, callers }] of Object.entries(PLAN_WRITERS)) {
      const reachedByRoute = callers.some((caller) => caller.startsWith('routes/'));
      if (!reachedByRoute) continue;
      checked += 1;
      expect(category, `${writer} is reachable from a route and is not audited`).toBe(AUDITED);
      // …and "audited" is not a label. The function's own body emits it.
      const at = repository.indexOf(`export async function ${writer}(`);
      expect(at, `${writer} is not declared where the map says`).toBeGreaterThan(-1);
      const body = repository.slice(at, at + 2000);
      expect(body, `${writer} writes without a record`).toContain('recordConfigChange({');
      expect(body, `${writer} takes no actor`).toContain('actor: ConfigAuditActor');
    }
    // The floor: the loop ran. A map with no route-reachable writer would pass
    // every assertion above by executing none of them.
    expect(checked).toBeGreaterThanOrEqual(1);

    // And the census can tell the two apart: `insertPlan` is a writer with no
    // record, so a predicate that saw one everywhere would be broken.
    const insertAt = repository.indexOf('export async function insertPlan(');
    expect(repository.slice(insertAt, insertAt + 400)).not.toContain('recordConfigChange({');
  });

  it('the audited writer can touch the model list and nothing else', () => {
    // What keeps it narrow is the SIGNATURE: a list, not an updates object, so
    // there is no field to widen and no `req.body` to spread. Price, Stripe ids,
    // the plan's identity and its product are unreachable through it.
    const repository = code('db/billing/planRepository.ts');
    expect(repository).toMatch(
      /export async function setPlanModelIds\(\s*db: ApiDatabase,\s*planId: string,\s*modelIds: readonly string\[\],\s*actor: ConfigAuditActor,\s*\)/,
    );
    const at = repository.indexOf('export async function setPlanModelIds(');
    const body = repository.slice(at, at + 1200);
    // One `set`, one column, and the column named. A second `.set(` — or a
    // first one taking a variable instead of this literal — is the change that
    // would turn a one-column writer into an update-object writer.
    const sets = [...body.matchAll(/\.set\((?<arg>\{[^}]*\})\)/g)];
    expect(sets).toHaveLength(1);
    expect(sets[0].groups?.arg).toBe('{ modelIds: [...modelIds] }');
    expect([...body.matchAll(/\.set\(/g)]).toHaveLength(1);

    // And its route never spreads a body or builds an update object.
    const route = code('routes/internal.ts');
    expect(route).not.toMatch(/\.\.\.req\.body/);
    expect(route).toContain("(body as Record<string, unknown>).model_ids");
  });

  it('the one Stripe writer still cannot touch model access', () => {
    // `updatePlanByPlanId` has a caller, so what makes it safe is its ARGUMENT
    // TYPE at that caller: three Stripe identifier fields, none of which is
    // `modelIds`. Widening this signature would open a SECOND request-driven
    // path to model access, and an unaudited one.
    const client = code('lib/gateway-client.ts');
    expect(client).toMatch(
      /export async function updatePlan\(\s*planId: string,\s*updates: \{ stripeProductId\?: string; stripeMonthlyPriceId\?: string; stripeAnnualPriceId\?: string \},/,
    );
    expect(client).toContain('updatePlanByPlanId(getDb(), planId, updates)');

    const prices = code('lib/stripe-prices.ts');
    expect(prices).toContain('updatePlan(plan.planId, { stripeProductId: product.id })');
    expect(prices).not.toContain('modelIds');
    expect(callersOf('updatePlan', ['db/billing/', 'lib/gateway-client.ts'])).toEqual([
      'lib/stripe-prices.ts',
    ]);
  });

  it('the plan seeder NEVER overwrites the model list of a row that exists', () => {
    /**
     * The inverted assertion, and the one this whole block turns on.
     *
     * It used to require the opposite — `onConflictDoUpdate({ set: { modelIds:
     * values.modelIds ?? [] } })` — with a comment warning that
     * `onConflictDoNothing` would make the DATABASE the authority for which
     * models a plan grants, "with no writer requiring authentication and no
     * record of who changed it".
     *
     * That warning was right about the danger and wrong about the fix. The
     * database IS the authority now, and what makes that safe is the thing the
     * warning said was missing: `setPlanModelIds` requires a service credential
     * and emits a record. With that writer in place, a seeder that re-asserted
     * the list would revert every product-team decision on the next deploy —
     * silently, because a deploy is not a change anybody reviews as one.
     *
     * So `onConflictDoNothing` is now REQUIRED and `onConflictDoUpdate` is
     * forbidden, which is exactly the reverse of what this file asserted, and
     * the reversal is the point.
     */
    const repository = code('db/billing/planRepository.ts');
    expect(repository).toMatch(
      /export async function seedPlan\([\s\S]{0,400}?onConflictDoNothing\(\{ target: plans\.planId \}\)/,
    );
    // The forbidden shape, named so the failure says which mistake was made.
    const at = repository.indexOf('export async function seedPlan(');
    expect(repository.slice(at, at + 900)).not.toContain('onConflictDoUpdate');
    expect(repository.slice(at, at + 900)).not.toContain('modelIds:');

    // The values it inserts still come from a source file, not from a query,
    // and never from a request.
    const seed = code('lib/seed-plans.ts');
    expect(seed).toMatch(/modelIds: FREE_MODEL_IDS/);
    expect([...seed.matchAll(/modelIds:/g)].length).toBeGreaterThanOrEqual(7);
    expect(seed).not.toContain('req.body');
  });

  it('the seeder RUNS, from the deploy one-shot, and from nowhere else', () => {
    /**
     * The other inversion, corrected a second time — and the correction is the
     * point of this assertion rather than an edit to it.
     *
     * It first read "the seeder has no caller, which is why this is a GAP".
     * Then plan seeding moved to `src/index.ts` and this asserted the
     * ENTRYPOINT called it, which read as wired. **It was not.** Everything in
     * `startBackgroundServices()` is reached only from `connectDB().then(...)`,
     * a Mongo connection that no longer exists and never resolves, so the call
     * this assertion pinned ran never — and production holds 0 `plans`,
     * measured 2026-08-18. A caller is not a trigger, and asserting the call
     * site could not tell the two apart.
     *
     * So it now pins the DEPLOY ONE-SHOT, which is a trigger: `scripts/seed.ts`
     * is invoked by `deploy-aws.yml` after the rollout. Wiring it is still only
     * safe BECAUSE seeding is insert-only, which the assertion above pins; the
     * two must move together or not at all.
     */
    const seeder = code('scripts/seed.ts');
    // Positive control: the scan can see this file at all, and it is the seeder.
    expect(seeder.length).toBeGreaterThan(1_000);
    expect(seeder).toContain('seedPlans');

    // The trigger, not merely a caller: the workflow issues the command, and the
    // build emits the file that command names. Either half missing is a seeder
    // wired to nothing, which is the exact state this assertion failed to catch
    // last time.
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy-aws.yml'), 'utf8');
    expect(workflow).toContain('packages/api/dist/scripts/seed.js');
    expect(readFileSync(path.join(REPO_ROOT, 'packages/api/build.ts'), 'utf8'))
      .toContain("outfile: 'dist/scripts/seed.js'");

    // And `index.ts` no longer claims to seed plans, because it never did.
    const api = sourceFiles('packages/api/src');
    expect(api.length).toBeGreaterThan(200);
    // A REFERENCE, not a call: `scripts/seed.ts` holds the seeders in a table and
    // invokes them through it, so a `seedPlans\s*\(` regex would find nothing and
    // pass while wired to nothing — the precise failure this assertion is being
    // rewritten to stop making.
    expect(api.filter((f) => f !== 'lib/seed-plans.ts' && /\bseedPlans\b/.test(code(f)))).toEqual([
      'scripts/seed.ts',
    ]);
    expect(code('index.ts')).not.toContain('seedPlans');
  });

  it('no route writes plan configuration except through the audited writer', () => {
    // The other direction: a new admin surface arrives as a ROUTE more often
    // than as a caller of an existing writer. The unaudited writers stay
    // unreachable from `routes/`; the audited one is expected there and is
    // asserted to be there, so this cannot pass by every writer disappearing.
    const routes = sourceFiles('packages/api/src/routes');
    expect(routes.length).toBeGreaterThan(20);

    const forbidden =
      /\b(insertPlan|deletePlanByPlanId|upsertPlanFeature|deletePlanFeature|seedPlan|seedPlanFeatures)\s*\(/;
    expect(routes.filter((relative) => forbidden.test(code(relative)))).toEqual([]);
    // The control: the same predicate finds the writer where it is called.
    expect(forbidden.test(code('lib/seed-plans.ts'))).toBe(true);

    // And the audited one IS reached from exactly one route.
    expect(routes.filter((relative) => /\bsetPlanModelIds\s*\(/.test(code(relative)))).toEqual([
      'routes/internal.ts',
    ]);
  });
});
