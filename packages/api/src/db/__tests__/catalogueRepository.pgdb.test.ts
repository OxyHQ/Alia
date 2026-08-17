import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { constraintNameOf, isForeignKeyViolation, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  deletePlanByPlanId,
  findPlanByPlanId,
  insertPlan,
  seedPlan,
  selectPlans,
  setPlanModelIds,
  updatePlanByPlanId,
} from '../billing/planRepository';
import type { ConfigAuditActor } from '../../lib/security/config-audit';
import {
  deleteFeatureByFeatureId,
  findFeatureByFeatureId,
  insertFeature,
  seedFeature,
  selectAllFeatures,
  selectFeatures,
  updateFeatureByFeatureId,
} from '../billing/featureRepository';
import {
  deleteCreditPackageByPackageId,
  insertCreditPackage,
  seedCreditPackage,
  selectCreditPackages,
  updateCreditPackageByPackageId,
} from '../billing/creditPackageRepository';
import {
  bulkUpsertPlanFeatures,
  deletePlanFeature,
  seedPlanFeatures,
  selectPlanFeatures,
  upsertPlanFeature,
} from '../billing/planFeatureRepository';
import { planFeatures, plans } from '../schema/billing';

/**
 * Both audited writers take an actor and neither defaults one, so every call
 * here names who is asking. `seed` and `user` are different answers and the
 * record has to be able to tell them apart.
 */
const SEED: ConfigAuditActor = { kind: 'seed', id: 'catalogueRepository.pgdb.test.ts' };
const ACTOR: ConfigAuditActor = { kind: 'user', id: 'oxy-user-1' };

/**
 * The pricing catalogue — `plans`, `features`, `plan_features`,
 * `credit_packages` — against a real server.
 *
 * Three of the properties here have no mocked counterpart at all: the foreign
 * keys that now REFUSE an orphan mapping, the cascade that removes a withdrawn
 * plan's entitlements, and `xmax = 0`, which is the only way to recover Mongo's
 * `upsertedCount` from a Postgres upsert.
 *
 * Business keys are namespaced `cat-` so this file cannot collide with another's
 * fixtures — `plan_id`, `feature_id` and `package_id` are all unique GLOBALLY and
 * the pgdb suite shares one database per run.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const aPlan = (planId: string, over: Partial<typeof plans.$inferInsert> = {}) => ({
  planId,
  name: `Plan ${planId}`,
  product: 'alia',
  ...over,
});

describe('plans', () => {
  it('round-trips a plan and finds it by its BUSINESS key', async () => {
    const created = await insertPlan(db, aPlan('cat-basic', { monthlyPrice: 1200, sortOrder: 3 }));
    // `plan_id`, not the surrogate `id` — nothing outside the repository names
    // a plan any other way.
    expect(created.planId).toBe('cat-basic');
    const found = await findPlanByPlanId(db, 'cat-basic');
    expect(found?.monthlyPrice).toBe(1200);
    // `bigint({ mode: 'number' })`: money must not arrive as a string.
    expect(typeof found?.monthlyPrice).toBe('number');
  });

  it('refuses a duplicate plan id by CONSTRAINT NAME', async () => {
    await insertPlan(db, aPlan('cat-dup'));
    let caught: unknown;
    try {
      await insertPlan(db, aPlan('cat-dup'));
    } catch (error) {
      caught = error;
    }
    /**
     * Caught by name through `@oxyhq/db`, never `error.code`: a drizzle error's
     * SQLSTATE lives on `cause`, so a ported `err.code === '23505'` matches
     * nothing and the route's 409 silently becomes a 500.
     */
    expect(isUniqueViolation(caught)).toBe(true);
    expect(constraintNameOf(caught)).toBe('plans_plan_id_key');
  });

  it('filters on all four keys and orders by product then sortOrder', async () => {
    await insertPlan(db, aPlan('cat-f-a', { product: 'alia', sortOrder: 2, isActive: true, isFree: false }));
    await insertPlan(db, aPlan('cat-f-b', { product: 'alia', sortOrder: 1, isActive: true, isFree: true }));
    await insertPlan(db, aPlan('cat-f-c', { product: 'codea', sortOrder: 1, isActive: false, isFree: false }));

    const mine = (rows: { planId: string }[]) => rows.map((r) => r.planId).filter((id) => id.startsWith('cat-f-'));

    // `product` asc then `sortOrder` asc — 'alia' before 'codea', and b before a.
    expect(mine(await selectPlans(db))).toEqual(['cat-f-b', 'cat-f-a', 'cat-f-c']);
    expect(mine(await selectPlans(db, { product: 'codea' }))).toEqual(['cat-f-c']);
    expect(mine(await selectPlans(db, { isActive: false }))).toEqual(['cat-f-c']);
    expect(mine(await selectPlans(db, { isFree: true }))).toEqual(['cat-f-b']);
    expect(mine(await selectPlans(db, { planId: 'cat-f-a' }))).toEqual(['cat-f-a']);
    // Two keys AND together rather than replacing one another.
    expect(mine(await selectPlans(db, { product: 'alia', isFree: false }))).toEqual(['cat-f-a']);
  });

  it('answers null for an update or delete naming no plan', async () => {
    // The empty RETURNING set IS "no such plan" — the discrimination the source
    // got from `findOneAndUpdate` returning null.
    expect(await updatePlanByPlanId(db, 'cat-absent', { name: 'x' })).toBeNull();
    expect(await deletePlanByPlanId(db, 'cat-absent')).toBeNull();
  });

  it('an empty update is a read, not invalid SQL', async () => {
    await insertPlan(db, aPlan('cat-empty-update', { name: 'unchanged' }));
    const row = await updatePlanByPlanId(db, 'cat-empty-update', {});
    expect(row?.name).toBe('unchanged');
  });
});

describe('seedPlan', () => {
  it('reports INSERTED on the first run and not on the second', async () => {
    const values = aPlan('cat-seed', { modelIds: ['m1'], name: 'Seeded', monthlyPrice: 500 });

    expect((await seedPlan(db, values, SEED)).inserted).toBe(true);
    /**
     * The second call is the whole point, and the mechanism changed with the
     * behaviour. It used to be `ON CONFLICT DO UPDATE ... RETURNING (xmax = 0)`,
     * because `rowCount` is 1 both times — it behaves like Mongo's
     * `matchedCount` — so a port reading it would report every re-run as a
     * fresh seed. `DO NOTHING RETURNING` returns NO ROW on conflict, so the
     * empty result IS the conflict branch and `xmax` is not needed.
     */
    expect((await seedPlan(db, { ...values, modelIds: ['m2'] }, SEED)).inserted).toBe(false);
  });

  it('NEVER overwrites the model list of a plan that already exists', async () => {
    /**
     * The inverted assertion, and the design change it records.
     *
     * This test read *"re-syncs the code-managed modelIds and leaves
     * admin-managed fields alone"* and asserted `modelIds` came back as the
     * seed's value. That was the Mongo-era contract, and #139 workstream 14
     * reverses it: `setPlanModelIds` is the authority for which models a plan
     * grants, so a boot writer that re-asserted the list would silently revert
     * every product-team change on the next deploy. A runtime writer and a boot
     * writer cannot both own one column.
     *
     * The old expectation is not deleted, it is inverted: `['new']` was the
     * pass, and it is now the failure.
     */
    await seedPlan(db, aPlan('cat-seed-sync', { modelIds: ['old'], name: 'Original', monthlyPrice: 100 }), SEED);
    // Somebody changes the plan through the runtime writer and the API...
    await setPlanModelIds(db, 'cat-seed-sync', ['chosen'], ACTOR);
    await updatePlanByPlanId(db, 'cat-seed-sync', { name: 'Admin renamed', monthlyPrice: 999 });
    // ...and the next boot re-seeds.
    await seedPlan(db, aPlan('cat-seed-sync', { modelIds: ['new'], name: 'Original', monthlyPrice: 100 }), SEED);

    const row = await findPlanByPlanId(db, 'cat-seed-sync');
    // Not `['new']`. The seed no longer has an opinion about an existing row.
    expect(row?.modelIds).toEqual(['chosen']);
    // And every other field is still untouched, which was always the contract.
    expect(row?.name).toBe('Admin renamed');
    expect(row?.monthlyPrice).toBe(999);
  });

  it('still creates a plan a database does not have', async () => {
    // The other direction, so "never overwrites" cannot be satisfied by never
    // writing at all.
    await seedPlan(db, aPlan('cat-seed-fresh', { modelIds: ['alia-lite'], name: 'Fresh' }), SEED);
    const row = await findPlanByPlanId(db, 'cat-seed-fresh');
    expect(row?.modelIds).toEqual(['alia-lite']);
    expect(row?.name).toBe('Fresh');
  });
});

describe('setPlanModelIds', () => {
  it('writes the model list and nothing else', async () => {
    await insertPlan(
      db,
      aPlan('cat-set-models', { modelIds: ['alia-lite'], name: 'Go', monthlyPrice: 399, isFree: false }),
    );

    const row = await setPlanModelIds(db, 'cat-set-models', ['alia-lite', 'alia-v1'], ACTOR);
    expect(row?.modelIds).toEqual(['alia-lite', 'alia-v1']);

    // The columns a caller must not be able to reach through this function.
    // There is no `updates` object to widen, so this is a signature property
    // rather than a convention — asserted anyway, because the next change to
    // this function is the one that would break it.
    const after = await findPlanByPlanId(db, 'cat-set-models');
    expect(after?.name).toBe('Go');
    expect(after?.monthlyPrice).toBe(399);
    expect(after?.isFree).toBe(false);
    expect(after?.planId).toBe('cat-set-models');
  });

  it('answers null for a plan that does not exist, and writes nothing', async () => {
    expect(await setPlanModelIds(db, 'cat-set-absent', ['alia-lite'], ACTOR)).toBeNull();
    expect(await findPlanByPlanId(db, 'cat-set-absent')).toBeNull();
  });

  it('empties the list when that is what was asked for', async () => {
    // `[]` is a decision — "this plan grants no models" — and must not be
    // confused with "no change", which is the shape a truthy check produces.
    await insertPlan(db, aPlan('cat-set-empty', { modelIds: ['alia-lite'] }));
    const row = await setPlanModelIds(db, 'cat-set-empty', [], ACTOR);
    expect(row?.modelIds).toEqual([]);
  });
});

describe('features', () => {
  it('round-trips, filters and orders by category then sortOrder', async () => {
    await insertFeature(db, { featureId: 'cat-feat-b', label: 'B', category: 'cat-zone', sortOrder: 2 });
    await insertFeature(db, { featureId: 'cat-feat-a', label: 'A', category: 'cat-zone', sortOrder: 1 });
    await insertFeature(db, { featureId: 'cat-feat-off', label: 'Off', category: 'cat-zone', sortOrder: 3, isActive: false });

    const inZone = await selectFeatures(db, { category: 'cat-zone' });
    expect(inZone.map((f) => f.featureId)).toEqual(['cat-feat-a', 'cat-feat-b', 'cat-feat-off']);

    const active = await selectFeatures(db, { category: 'cat-zone', isActive: true });
    expect(active.map((f) => f.featureId)).toEqual(['cat-feat-a', 'cat-feat-b']);

    // The unfiltered read is what the broadcast sends; it must include the
    // inactive one, so "active" above is filtering rather than a missing seed.
    const all = await selectAllFeatures(db);
    expect(all.some((f) => f.featureId === 'cat-feat-off')).toBe(true);
  });

  it('updates and deletes by feature id, answering null for a miss', async () => {
    await insertFeature(db, { featureId: 'cat-feat-edit', label: 'Before', category: 'cat-zone' });
    expect((await updateFeatureByFeatureId(db, 'cat-feat-edit', { label: 'After' }))?.label).toBe('After');
    expect(await updateFeatureByFeatureId(db, 'cat-feat-nope', { label: 'x' })).toBeNull();
    expect((await deleteFeatureByFeatureId(db, 'cat-feat-edit'))?.featureId).toBe('cat-feat-edit');
    expect(await findFeatureByFeatureId(db, 'cat-feat-edit')).toBeNull();
  });

  it('seeds once and never overwrites an admin edit', async () => {
    const values = { featureId: 'cat-feat-seed', label: 'Seeded', category: 'cat-zone' };
    expect((await seedFeature(db, values)).inserted).toBe(true);
    await updateFeatureByFeatureId(db, 'cat-feat-seed', { label: 'Admin label' });
    // `$setOnInsert`-only, so `DO NOTHING` and the ROW COUNT answer it exactly —
    // no `xmax` needed, because there is no update branch to confuse it.
    expect((await seedFeature(db, values)).inserted).toBe(false);
    expect((await findFeatureByFeatureId(db, 'cat-feat-seed'))?.label).toBe('Admin label');
  });
});

describe('credit packages', () => {
  it('round-trips and orders by sortOrder, with price as a number', async () => {
    await insertCreditPackage(db, { packageId: 'cat-pkg-b', name: 'B', credits: 100, price: 999, sortOrder: 2 });
    await insertCreditPackage(db, { packageId: 'cat-pkg-a', name: 'A', credits: 50, price: 499, sortOrder: 1, isActive: false });

    const all = (await selectCreditPackages(db)).filter((p) => p.packageId.startsWith('cat-pkg-'));
    expect(all.map((p) => p.packageId)).toEqual(['cat-pkg-a', 'cat-pkg-b']);
    expect(typeof all[0]?.price).toBe('number');

    const active = (await selectCreditPackages(db, { isActive: true })).filter((p) => p.packageId.startsWith('cat-pkg-'));
    expect(active.map((p) => p.packageId)).toEqual(['cat-pkg-b']);
  });

  it('the CHECKs make a zero-credit package and a negative price unrepresentable', async () => {
    // The routes validate too, so a bad request is a 400 rather than a 500 —
    // but the constraint is what holds however the row is written, and it has
    // no mocked counterpart.
    let zeroCredits: unknown;
    try {
      await insertCreditPackage(db, { packageId: 'cat-pkg-zero', name: 'Zero', credits: 0, price: 100 });
    } catch (error) {
      zeroCredits = error;
    }
    expect(constraintNameOf(zeroCredits)).toBe('credit_packages_credits_check');

    let negativePrice: unknown;
    try {
      await insertCreditPackage(db, { packageId: 'cat-pkg-neg', name: 'Neg', credits: 10, price: -1 });
    } catch (error) {
      negativePrice = error;
    }
    expect(constraintNameOf(negativePrice)).toBe('credit_packages_price_check');
  });

  it('updates, deletes and seeds idempotently', async () => {
    const values = { packageId: 'cat-pkg-seed', name: 'Seeded', credits: 10, price: 100 };
    expect((await seedCreditPackage(db, values)).inserted).toBe(true);
    await updateCreditPackageByPackageId(db, 'cat-pkg-seed', { price: 200 });
    expect((await seedCreditPackage(db, values)).inserted).toBe(false);
    const rows = await selectCreditPackages(db, {});
    expect(rows.find((p) => p.packageId === 'cat-pkg-seed')?.price).toBe(200);
    expect((await deleteCreditPackageByPackageId(db, 'cat-pkg-seed'))?.packageId).toBe('cat-pkg-seed');
    expect(await deleteCreditPackageByPackageId(db, 'cat-pkg-seed')).toBeNull();
  });
});

describe('plan features', () => {
  beforeAll(async () => {
    await insertPlan(db, aPlan('cat-pf-plan'));
    await insertFeature(db, { featureId: 'cat-pf-feat', label: 'F', category: 'cat-zone' });
    await insertFeature(db, { featureId: 'cat-pf-feat2', label: 'F2', category: 'cat-zone' });
  });

  it('REFUSES a mapping naming a plan that does not exist', async () => {
    /**
     * Mongo created the orphan happily. The foreign key is what makes the
     * difference, and the route turns `23503` into a 400 — so this is the
     * assertion that keeps that branch reachable.
     */
    let caught: unknown;
    try {
      await upsertPlanFeature(db, 'cat-pf-no-such-plan', 'cat-pf-feat', { enabled: true });
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught)).toBe(true);
    expect(constraintNameOf(caught)).toBe('plan_features_plan_id_fk');
  });

  it('REFUSES a mapping naming a feature that does not exist', async () => {
    let caught: unknown;
    try {
      await upsertPlanFeature(db, 'cat-pf-plan', 'cat-pf-no-such-feature', { enabled: true });
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught)).toBe(true);
    expect(constraintNameOf(caught)).toBe('plan_features_feature_id_fk');
  });

  it('upserts on (plan, feature) and leaves an UNSUPPLIED field alone', async () => {
    await upsertPlanFeature(db, 'cat-pf-plan', 'cat-pf-feat', {
      enabled: true,
      limitValue: 25,
      displayLabel: 'Twenty five',
    });

    // The second call supplies neither `limitValue` nor `displayLabel`.
    // Mongoose strips `undefined` out of a `$set`, so the stored values must
    // survive — a port passing `undefined` straight through would null them.
    const row = await upsertPlanFeature(db, 'cat-pf-plan', 'cat-pf-feat', { enabled: false });
    expect(row.enabled).toBe(false);
    expect(row.limitValue).toBe(25);
    expect(row.displayLabel).toBe('Twenty five');

    const rows = await selectPlanFeatures(db, { planId: 'cat-pf-plan' });
    expect(rows).toHaveLength(1);
  });

  it('bulk upsert separates rows it INSERTED from rows it updated', async () => {
    const result = await bulkUpsertPlanFeatures(db, [
      { planId: 'cat-pf-plan', featureId: 'cat-pf-feat', values: { enabled: true } },
      { planId: 'cat-pf-plan', featureId: 'cat-pf-feat2', values: { enabled: true, limitValue: 7 } },
    ]);
    // `cat-pf-feat` already exists from the test above; `cat-pf-feat2` is new.
    expect(result).toEqual({ upserted: 1, modified: 1 });

    // Run it again and NOTHING is new — the discriminator a single run cannot
    // give, and the figure the admin grid reports back.
    const again = await bulkUpsertPlanFeatures(db, [
      { planId: 'cat-pf-plan', featureId: 'cat-pf-feat', values: { enabled: true } },
      { planId: 'cat-pf-plan', featureId: 'cat-pf-feat2', values: { enabled: true } },
    ]);
    expect(again).toEqual({ upserted: 0, modified: 2 });
  });

  it('the seed inserts only, never resetting an existing mapping', async () => {
    await insertPlan(db, aPlan('cat-pf-seedplan'));
    const first = await seedPlanFeatures(db, [
      { planId: 'cat-pf-seedplan', featureId: 'cat-pf-feat', enabled: true, limitValue: 1 },
    ]);
    expect(first.upserted).toBe(1);

    await upsertPlanFeature(db, 'cat-pf-seedplan', 'cat-pf-feat', { limitValue: 42 });

    const second = await seedPlanFeatures(db, [
      { planId: 'cat-pf-seedplan', featureId: 'cat-pf-feat', enabled: true, limitValue: 1 },
    ]);
    // `$setOnInsert`-only: `DO NOTHING`, so the count is exact and the admin's
    // 42 is untouched.
    expect(second.upserted).toBe(0);
    const rows = await selectPlanFeatures(db, { planId: 'cat-pf-seedplan' });
    expect(rows[0]?.limitValue).toBe(42);
  });

  it('deleting a PLAN cascades its mappings away', async () => {
    await insertPlan(db, aPlan('cat-cascade-plan'));
    await upsertPlanFeature(db, 'cat-cascade-plan', 'cat-pf-feat', { enabled: true });
    expect(await selectPlanFeatures(db, { planId: 'cat-cascade-plan' })).toHaveLength(1);

    /**
     * A deliberate change from Mongo, which left the mapping behind — where a
     * plan re-created under the same id silently inherited the withdrawn one's
     * entitlements. The cascade is the schema's, and this is where it shows.
     */
    await deletePlanByPlanId(db, 'cat-cascade-plan');
    expect(await selectPlanFeatures(db, { planId: 'cat-cascade-plan' })).toHaveLength(0);
  });

  it('deleting a FEATURE cascades its mappings away', async () => {
    await insertPlan(db, aPlan('cat-cascade-plan2'));
    await insertFeature(db, { featureId: 'cat-cascade-feat', label: 'C', category: 'cat-zone' });
    await upsertPlanFeature(db, 'cat-cascade-plan2', 'cat-cascade-feat', { enabled: true });

    await deleteFeatureByFeatureId(db, 'cat-cascade-feat');
    const left = await db
      .select()
      .from(planFeatures)
      .where(eq(planFeatures.featureId, 'cat-cascade-feat'));
    expect(left).toHaveLength(0);
  });

  it('deletes one mapping and answers null for a miss', async () => {
    await insertPlan(db, aPlan('cat-pf-del'));
    await upsertPlanFeature(db, 'cat-pf-del', 'cat-pf-feat', { enabled: true });
    expect((await deletePlanFeature(db, 'cat-pf-del', 'cat-pf-feat'))?.planId).toBe('cat-pf-del');
    expect(await deletePlanFeature(db, 'cat-pf-del', 'cat-pf-feat')).toBeNull();
  });

  it('orders by plan then feature', async () => {
    await insertPlan(db, aPlan('cat-pf-order'));
    await upsertPlanFeature(db, 'cat-pf-order', 'cat-pf-feat2', { enabled: true });
    await upsertPlanFeature(db, 'cat-pf-order', 'cat-pf-feat', { enabled: true });
    const rows = await selectPlanFeatures(db, { planId: 'cat-pf-order' });
    expect(rows.map((r) => r.featureId)).toEqual(['cat-pf-feat', 'cat-pf-feat2']);
  });
});
