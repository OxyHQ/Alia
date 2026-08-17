import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_PLAN_STATUSES, productEntitlementSchema } from '@oxyhq/contracts';

/**
 * Plan and entitlement checks — epic #139 workstream 6, *"`/alia/chat` or its
 * successor remains responsible for … plan/entitlement checks"*.
 *
 * ## What is already guarded, and what is not
 *
 * `chatFlowFixtures.test.ts` pins the GATE: an app request for a model outside
 * the allow-list is refused 403 `MODEL_NOT_IN_PLAN` and its reservation is
 * refunded, and an API-key request skips the gate entirely. Both drive the real
 * handler. Neither says anything about where the allow-list COMES FROM, because
 * both mock `getUserEntitlements` and hand the answer in.
 *
 * That is the half this file covers, and it is where the interesting failures
 * are, because every one of them is permissive or silent:
 *
 *  - the free floor. `FREE_MODEL_IDS` is what an account with no subscription
 *    may use. Empty it and every free user is refused every model — a total
 *    outage for the majority of accounts, from a one-line edit in a file whose
 *    name says "plan access";
 *  - the ACTIVE filter. Entitlements are read from live subscriptions only, so a
 *    cancelled or past-due plan stops granting. Widen it and a cancelled
 *    customer keeps their models;
 *  - the five-minute cache. It is what makes the gate cheap enough to run on
 *    every request, and it is also why a plan change has to say so explicitly.
 *    A missing invalidation is invisible: the user upgrades, is refused for a
 *    few minutes, retries, and it works.
 */

/**
 * A row `findActiveSubscriptions` could really return.
 *
 * Only the columns the read model reads, and all of them: `plan-access.ts`
 * renders the contract's `ProductPlan` from this row, so a fixture carrying
 * `planSnapshotPlanId` alone would make every assertion below a statement about
 * a shape the repository never produces.
 */
const subscription = (planSnapshotPlanId: string | null) => ({
  planSnapshotPlanId,
  planSnapshotName: `${planSnapshotPlanId ?? 'none'} plan`,
  status: 'active',
  currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
  currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
});

const H = vi.hoisted(() => ({
  /** Rows `findActiveSubscriptions` returns, and how many times it was asked. */
  subscriptions: [] as Array<ReturnType<typeof subscription>>,
  subscriptionReads: 0,
  plans: [] as Array<{ planId: string; modelIds?: string[] }>,
  planFeatures: [] as Array<{ planId: string; featureId: string; enabled?: boolean; limitValue?: number | null }>,
}));

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/billing/subscriptionRepository.js', () => ({
  findActiveSubscriptions: vi.fn(async () => {
    H.subscriptionReads += 1;
    return H.subscriptions;
  }),
}));

vi.mock('../gateway-client.js', () => ({
  getPlans: vi.fn(async () => H.plans),
  getPlanFeatures: vi.fn(async (planId: string) => H.planFeatures.filter((f) => f.planId === planId)),
}));

import { getUserEntitlements, invalidateEntitlementsCache } from '../plan-access.js';

const API_SRC = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

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

/** A fresh account id per assertion, because the cache is module-level. */
let seq = 0;
const account = (): string => `user-ent-${(seq += 1)}`;

beforeEach(() => {
  H.subscriptions = [];
  H.subscriptionReads = 0;
  H.plans = [];
  H.planFeatures = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  The interface between Oxy and Alia                                         */
/* -------------------------------------------------------------------------- */

/**
 * Epic #139 workstream 12, *"Define the final entitlement API between Oxy and
 * Alia"*, and ADR 0005's *"Alia keeps entitlements as a low-latency read
 * model"*.
 *
 * The shape is `@oxyhq/contracts`'s `productEntitlementSchema` rather than a
 * local interface, so what is asserted here is that the read model really
 * produces a value that schema accepts — not that a local type compiles.
 *
 * `productEntitlementSchema` is imported from the package and NOT mocked: the
 * whole value of the check is that a third party owns the shape. The parse
 * already happens inside `plan-access.ts`, so a run that never reaches it would
 * also pass every assertion below; each one therefore names a FIELD.
 */
describe('the entitlement read model publishes the Oxy contract shape (#139 ws12)', () => {
  it('produces a value the contract schema accepts, and the schema can refuse one', () => {
    // The oracle's own positive control first: a schema that accepted anything
    // would make the assertion after it worthless. `strict` on every object is
    // what makes an invented field a failure rather than a passenger.
    const drifted = productEntitlementSchema.safeParse({
      schemaVersion: 1,
      accountId: 'acc',
      plan: null,
      allowances: [{ key: 'seats', included: 3, price: 900 }],
      payAsYouGo: null,
      costCenter: null,
      resolvedAt: new Date().toISOString(),
    });
    expect(drifted.success, 'the contract accepted a price on an allowance').toBe(false);

    // And it refuses a fractional allowance, which is the rule that keeps an
    // allowance from ever being money: `z.number().int()`, never a decimal.
    expect(
      productEntitlementSchema.safeParse({
        schemaVersion: 1,
        accountId: 'acc',
        plan: null,
        allowances: [{ key: 'seats', included: 2.5 }],
        payAsYouGo: null,
        costCenter: null,
        resolvedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);

    return getUserEntitlements(account()).then((entitlements) => {
      expect(productEntitlementSchema.safeParse(entitlements.entitlement).success).toBe(true);
      expect(entitlements.entitlement.schemaVersion).toBe(1);
      expect(entitlements.entitlement.plan).toBeNull();
      expect(typeof entitlements.entitlement.resolvedAt).toBe('string');
    });
  });

  it('renders a held plan from the subscription, with its allowances', async () => {
    H.subscriptions = [subscription('pro')];
    H.plans = [{ planId: 'pro' }];
    H.planFeatures = [
      { planId: 'pro', featureId: 'voice-minutes', limitValue: 600 },
      { planId: 'pro', featureId: 'voice-mode', enabled: true },
    ];

    const { entitlement } = await getUserEntitlements(account());

    expect(entitlement.plan).toEqual({
      id: 'pro',
      name: 'pro plan',
      status: 'active',
      live: true,
      currentPeriodStart: '2026-08-01T00:00:00.000Z',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      allowances: [{ key: 'voice_minutes', included: 600 }],
    });
    // A numeric LIMIT is an allowance; a boolean CAPABILITY is not. Rendering
    // `voice-mode` as `included: 1` would invent a quantity nothing counts down,
    // so its absence here is the assertion.
    // The key is the CONTRACT's namespace, not Alia's: `voice-minutes` has a
    // hyphen and `planAllowanceSchema.key` does not permit one.
    expect(entitlement.allowances).toEqual([{ key: 'voice_minutes', included: 600 }]);
    expect(entitlement.allowances.map((a) => a.key)).not.toContain('voice_mode');
  });

  it('keeps the boolean capability in the Alia-local view the product gate reads', async () => {
    // The other half of the split above, so "allowances omit it" cannot be
    // satisfied by the capability having been dropped altogether.
    H.subscriptions = [subscription('pro')];
    H.plans = [{ planId: 'pro' }];
    H.planFeatures = [
      { planId: 'pro', featureId: 'voice-minutes', limitValue: 600 },
      { planId: 'pro', featureId: 'voice-mode', enabled: true },
    ];

    const entitlements = await getUserEntitlements(account());
    expect(entitlements.features).toEqual({ 'voice-minutes': 600, 'voice-mode': true });
  });

  it('reports no pay-as-you-go position and no cost centre, because Alia holds neither', async () => {
    H.subscriptions = [subscription('pro')];
    H.plans = [{ planId: 'pro' }];

    const { entitlement } = await getUserEntitlements(account());

    /**
     * Both nulls are load-bearing. The contract's `payAsYouGo` carries MONEY as
     * exact decimal strings; Alia's `user_credits` carries a COUNT of AI
     * credits, and the two are not the same quantity. Synthesising one from the
     * other would merge the halves ADR 0005 separates, in the one object whose
     * job is keeping them apart — and it would read as a working feature.
     *
     * `billingSeparation.test.ts` holds the structural half: `plan-access.ts`
     * cannot import a balance to synthesise it from.
     */
    expect(entitlement.payAsYouGo).toBeNull();
    expect(entitlement.costCenter).toBeNull();
  });

  it('cannot render a status the contract has no word for', () => {
    // `planFrom` narrows `subscriptions.status` through the contract's enum and
    // THROWS rather than dropping the plan, because a silently absent plan is a
    // paying customer refused their models. That throw is unreachable only while
    // this containment holds — the read model reads live subscriptions alone.
    const repository = code('db/billing/subscriptionRepository.ts');
    const declaration = repository.match(
      /export const LIVE_SUBSCRIPTION_STATUSES = \[([^\]]*)\] as const;/,
    );
    const live = (declaration?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter((entry) => entry !== '');
    expect(live.length).toBeGreaterThan(0);
    for (const status of live) {
      expect(PRODUCT_PLAN_STATUSES as readonly string[], `${status} has no contract spelling`).toContain(status);
    }
    // The floor: the tuple being compared against is not empty, so the loop is
    // not passing by having nothing to check.
    expect(PRODUCT_PLAN_STATUSES.length).toBe(8);
  });
});

/* -------------------------------------------------------------------------- */
/*  What an account is entitled to                                             */
/* -------------------------------------------------------------------------- */

describe('entitlements are derived from live subscriptions (#139 ws6)', () => {
  it('gives an account with no subscription the free floor, not an empty list', () => {
    // Asserted as an exact set. A floor that merely "contains alia-lite" would
    // survive the models being widened to everything, which is the other
    // direction of the same mistake.
    expect(H.plans).toEqual([]);
    return getUserEntitlements(account()).then((entitlements) => {
      expect([...entitlements.allowedModelIds].sort()).toEqual(['alia-lite', 'alia-v1', 'alia-v1-audio']);
      expect(entitlements.planId).toBe('free');
      expect(entitlements.features).toEqual({});
    });
  });

  it('adds a paid plan on top of the floor rather than replacing it', async () => {
    // The additive shape is load-bearing: a paid plan lists only what it ADDS,
    // so a replacement would silently strip `alia-lite` from every paying
    // customer — the cheapest model, and the one titling uses.
    H.subscriptions = [subscription('pro')];
    H.plans = [
      { planId: 'pro', modelIds: ['alia-v1-pro', 'alia-v1-thinking'] },
      { planId: 'go', modelIds: ['alia-v1-codea'] },
    ];

    const entitlements = await getUserEntitlements(account());

    expect([...entitlements.allowedModelIds].sort()).toEqual([
      'alia-lite',
      'alia-v1',
      'alia-v1-audio',
      'alia-v1-pro',
      'alia-v1-thinking',
    ]);
    expect(entitlements.planId).toBe('pro');
    // The control: a plan the account does NOT hold contributed nothing, so the
    // list above is a filter and not "every plan in the catalogue".
    expect(entitlements.allowedModelIds).not.toContain('alia-v1-codea');
  });

  it('reads only the statuses Stripe calls live', () => {
    // The filter itself lives in SQL (`liveFor`), so what is asserted here is
    // the tuple it is built from. Widening it is how a cancelled customer keeps
    // their models, and the widening reads as a one-word addition.
    //
    // Read off comment-stripped SOURCE rather than imported, because this file
    // mocks that module — importing the constant would resolve to the mock and
    // the assertion would be about a literal written six lines above it.
    const repository = code('db/billing/subscriptionRepository.ts');
    const declaration = repository.match(
      /export const LIVE_SUBSCRIPTION_STATUSES = \[([^\]]*)\] as const;/,
    );
    expect(declaration, 'the live-status tuple is not where this test looks').not.toBeNull();
    const statuses = (declaration?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter((entry) => entry !== '');
    expect(statuses).toEqual(['active', 'trialing']);
    // Named individually so a red run says which state leaked in.
    for (const dead of ['canceled', 'past_due', 'incomplete', 'unpaid', 'paused']) {
      expect(statuses, `${dead} counted as a live subscription`).not.toContain(dead);
    }

    // And the tuple is what the predicate is built from — a second, drifting
    // literal inside `liveFor` would satisfy everything above.
    expect(repository).toMatch(
      /inArray\(subscriptions\.status, \[\.\.\.LIVE_SUBSCRIPTION_STATUSES\]\)/,
    );
    expect(repository).toMatch(/export async function findActiveSubscriptions\([\s\S]{0,300}?liveFor\(oxyUserId\)/);
    // And `plan-access.ts` really does ask for the live-only reader.
    expect(code('lib/plan-access.ts')).toContain('findActiveSubscriptions');
  });

  it('drops a disabled feature and keeps the highest limit across plans', async () => {
    H.subscriptions = [subscription('go'), subscription('pro')];
    H.plans = [{ planId: 'go' }, { planId: 'pro' }];
    H.planFeatures = [
      { planId: 'go', featureId: 'voice', enabled: true },
      { planId: 'go', featureId: 'seats', limitValue: 3 },
      { planId: 'pro', featureId: 'seats', limitValue: 10 },
      { planId: 'pro', featureId: 'retired', enabled: false },
    ];

    const entitlements = await getUserEntitlements(account());

    expect(entitlements.features).toEqual({ voice: true, seats: 10 });
    // `planId` names the paid plan, not 'free', when both are held.
    expect(entitlements.planId).not.toBe('free');
  });
});

/* -------------------------------------------------------------------------- */
/*  The cache, and the writes that must clear it                               */
/* -------------------------------------------------------------------------- */

describe('the entitlement cache is cleared by the writes that invalidate it (#139 ws6)', () => {
  it('serves a repeat read from cache and re-reads after an invalidation', async () => {
    const userId = account();
    H.subscriptions = [subscription('go')];
    H.plans = [{ planId: 'go', modelIds: ['alia-v1-codea'] }];

    await getUserEntitlements(userId);
    await getUserEntitlements(userId);
    // One read for two calls — the property that makes the gate affordable on
    // every request, and the reason the invalidation below has to exist.
    expect(H.subscriptionReads).toBe(1);

    // The account upgrades. Without the invalidation the next line still
    // answers the old allow-list, which is what a customer sees as "I paid and
    // it still says upgrade your plan".
    H.plans = [{ planId: 'go', modelIds: ['alia-v1-codea', 'alia-v1-pro'] }];
    invalidateEntitlementsCache(userId);
    const after = await getUserEntitlements(userId);

    expect(H.subscriptionReads).toBe(2);
    expect(after.allowedModelIds).toContain('alia-v1-pro');
  });

  it('invalidates one account and leaves the rest cached', async () => {
    const mine = account();
    const theirs = account();
    await getUserEntitlements(mine);
    await getUserEntitlements(theirs);
    expect(H.subscriptionReads).toBe(2);

    invalidateEntitlementsCache(mine);
    await getUserEntitlements(theirs);

    // Still 2: a `clear()` masquerading as a `delete()` would show 3 here, and
    // would turn every plan change into a cache stampede across all accounts.
    expect(H.subscriptionReads).toBe(2);
  });

  /**
   * Every subscription write in `routes/billing.ts`, and whether the account's
   * entitlements are re-read afterwards.
   *
   * A map rather than a list of checks, so a NEW write path fails the equality
   * instead of being skipped. The verdict per site is computed by reading the
   * comment-stripped source from that call up to the next one — which is what
   * makes "site 1 does not invalidate" a fact about site 1 and not about the
   * file containing the word somewhere.
   *
   * ## The finding this map records
   *
   * Two of the five do not invalidate, and only ONE of the two is correct:
   *
   *  - `cancel-at-period-end` sets a flag that `liveFor` does not read, so the
   *    account's entitlements genuinely have not changed. Correct.
   *  - `invoice-payment-failed` writes `status: 'past_due'`, which IS outside
   *    `LIVE_SUBSCRIPTION_STATUSES`, so the account has just lost its plan at
   *    the data layer while the cache keeps granting it for up to the TTL. It
   *    is bounded, self-healing and permissive, which is exactly why nobody has
   *    noticed it; it is pinned as the state it is rather than fixed here,
   *    because widening what a failed payment revokes and when is a billing
   *    decision. Change the verdict in the same commit that adds the call.
   */
  const SUBSCRIPTION_WRITES: ReadonlyArray<{
    readonly label: string;
    /** A literal inside this call, proving the segment is the site it claims. */
    readonly marker: string;
    readonly invalidates: boolean;
  }> = [
    { label: 'cancel-at-period-end', marker: 'cancelAtPeriodEnd: true', invalidates: false },
    { label: 'plan-change', marker: 'planId: targetPlan.planId', invalidates: true },
    { label: 'stripe-subscription-upserted', marker: 'oxyUserId: userCredits.id', invalidates: true },
    { label: 'stripe-subscription-deleted', marker: "status: 'canceled'", invalidates: true },
    { label: 'invoice-payment-failed', marker: "status: 'past_due'", invalidates: false },
  ];

  it('accounts for every subscription write, in order', () => {
    const billing = code('routes/billing.ts');
    // The floor: the file was read and is the billing router.
    expect(billing).toContain("router.post('/subscription/cancel'");
    expect(billing.length).toBeGreaterThan(10_000);

    const sites = [...billing.matchAll(/(?:update|upsert)SubscriptionByStripeId\(/g)].map((m) => m.index);
    expect(sites.length).toBe(SUBSCRIPTION_WRITES.length);

    for (const [index, site] of sites.entries()) {
      const segment = billing.slice(site, sites[index + 1] ?? billing.length);
      const expected = SUBSCRIPTION_WRITES[index];
      // The per-entry positive control: the segment really is the site the map
      // names, so the verdict below is not being read off the wrong call.
      expect(segment, `write #${index + 1} is not ${expected.label}`).toContain(expected.marker);
      expect(
        segment.includes('invalidateEntitlementsCache'),
        `${expected.label} changed whether it invalidates`,
      ).toBe(expected.invalidates);
    }
  });

  it('the census can see an invalidation, and cannot see a comment', () => {
    // Both controls, because both failures print the same tidy verdict. The
    // import line names the function without being a call site, and the plain
    // text of this repository's prose must not count either.
    const billing = code('routes/billing.ts');
    expect(billing).toContain('invalidateEntitlementsCache(userId);');
    expect(readFileSync(path.join(API_SRC, 'routes/catalogue.ts'), 'utf8')).toContain('plan-access.ts');
    expect(code('routes/catalogue.ts')).not.toContain('invalidateEntitlementsCache');
  });
});

/* -------------------------------------------------------------------------- */
/*  The entrypoint                                                             */
/* -------------------------------------------------------------------------- */

describe('the product runtime still runs the check (#139 ws6)', () => {
  it('prefetches entitlements and refuses a model outside the plan', () => {
    // The "green and inert" half. Everything above is about a function; this is
    // about the request path calling it. `chatFlowFixtures.test.ts` asserts the
    // 403 behaviourally, so what is added here is the SHAPE of the two
    // conditions, which are the parts a refactor would flatten without changing
    // any transcript: the prefetch skips API keys, and the gate does too.
    const context = code('lib/chat/request-context.ts');
    expect(context).toContain('export async function buildChatRequestContext');
    expect(context).toMatch(/\(req\.user && !req\.apiKey\)\s*\?\s*getUserEntitlements\(req\.user\.id\)/);
    expect(context).toMatch(
      /if \(req\.user && !req\.apiKey && entitlements\) \{\s*if \(!entitlements\.allowedModelIds\.includes\(aliasModelId\)\) \{/,
    );
    // Refund before refusal, because the reservation was already taken by the
    // parallel prefetch above it.
    expect(context).toMatch(
      /if \(!entitlements\.allowedModelIds\.includes\(aliasModelId\)\) \{\s*if \(creditReservation\) await refundReservation\(creditReservation\);/,
    );
    expect(context).toContain("code: 'MODEL_NOT_IN_PLAN'");
  });

  it('is reached from the entrypoint both chat surfaces share', () => {
    // The floor for the file above: it is what `handleChatCompletions` calls,
    // and that handler is the one object behind `/v1/chat/completions` and
    // `/alia/chat` (`routes/__tests__/unified-product-runtime.test.ts`).
    const route = code('routes/v1/chat-completions.ts');
    expect(route).toContain('export const handleChatCompletions');
    expect(route).toMatch(/const ctx = await buildChatRequestContext\(req, res, sse, globalTimer\);/);
    expect(route).toMatch(/if \(!ctx\) return;/);
  });
});
