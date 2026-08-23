import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `GET /billing/subscription` actually serves.
 *
 * Nothing asserted this, and the Postgres port changed it: the route started
 * returning the raw row — flat `planSnapshotName`, `planSnapshotPrice` — while
 * `packages/app` and `packages/alia-console` both read `subscription.plan.name`
 * and `subscription.plan.planId`. Every account was on the free floor and got
 * `null` here, so nobody saw it until one account had a subscription and its
 * plan rendered blank.
 *
 * The mocked half is the repository. The question here is the SHAPE of what
 * leaves the route, which is this file's whole subject.
 */

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  optionalAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  oxyClient: { getUserById: vi.fn() },
}));

vi.mock('../../db/billing/subscriptionRepository.js', () => ({
  findActiveSubscription: vi.fn(),
  updateSubscriptionByStripeId: vi.fn(),
  upsertSubscriptionByStripeId: vi.fn(),
}));

vi.mock('../../db/billing/userCreditsRepository.js', () => ({
  addCredits: vi.fn(),
  findUserCreditsByStripeCustomerId: vi.fn(),
  setStripeCustomerId: vi.fn(),
}));

vi.mock('../../db/billing/transactionRepository.js', () => ({
  countTransactionsForUser: vi.fn(),
  insertTransaction: vi.fn(),
  isDuplicateTransaction: vi.fn(),
  selectTransactionsForUser: vi.fn(),
}));

vi.mock('../../lib/gateway-client.js', () => ({
  getPlans: vi.fn(),
  getCreditPackages: vi.fn(),
  getFeatures: vi.fn(),
  getPlanFeatures: vi.fn(),
  getAllAliaModels: vi.fn(),
}));

vi.mock('../../lib/stripe-prices.js', () => ({ ensureStripePriceId: vi.fn() }));
vi.mock('../../lib/user-credits-helpers.js', () => ({ getOrCreateUserCredits: vi.fn() }));
vi.mock('../../lib/plan-access.js', () => ({
  getUserEntitlements: vi.fn(),
  invalidateEntitlementsCache: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  log: {
    credits: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { findActiveSubscription } from '../../db/billing/subscriptionRepository.js';
import router from '../billing.js';

type Handler = (req: Record<string, unknown>, res: MockResponse) => Promise<unknown>;

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] };
}

/** The LAST handler on the route, so the auth middleware is not what runs. */
function handlerFor(method: 'get', path: string): Handler {
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`no handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

interface MockResponse {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
}

function makeRes(): MockResponse {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

/** A row `findActiveSubscription` really returns — every column the route reads. */
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub-row-1',
  oxyUserId: 'oxy-user-1',
  stripeCustomerId: 'cus_123',
  stripeSubscriptionId: 'sub_123',
  stripePriceId: 'price_123',
  status: 'active',
  currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
  currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
  planId: 'pro',
  billingPeriod: 'monthly',
  planSnapshotPlanId: 'pro',
  planSnapshotName: 'Pro',
  planSnapshotProduct: 'alia',
  planSnapshotCreditsPerMonth: 10000,
  planSnapshotPrice: 999,
  planSnapshotCurrency: 'usd',
  planSnapshotBillingPeriod: 'monthly',
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  ...overrides,
});

async function getSubscription(user: unknown = { id: 'oxy-user-1' }): Promise<MockResponse> {
  const res = makeRes();
  await handlerFor('get', '/subscription')({ user, query: {} }, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /billing/subscription', () => {
  it('serves the plan NESTED, which is what every client reads', async () => {
    vi.mocked(findActiveSubscription).mockResolvedValue(row() as never);
    const { body } = await getSubscription();
    const { subscription } = body as { subscription: Record<string, unknown> };

    // The exact keys `packages/app` and `packages/alia-console` index into.
    expect(subscription.plan).toEqual({
      planId: 'pro',
      name: 'Pro',
      product: 'alia',
      creditsPerMonth: 10000,
      price: 999,
      currency: 'usd',
      billingPeriod: 'monthly',
    });
    expect(subscription.status).toBe('active');
    expect(subscription.cancelAtPeriodEnd).toBe(false);
  });

  it('does not leak the Stripe or owner ids', async () => {
    // No client reads one, and shipping `stripeSubscriptionId` would invite a
    // client to test the `comp_` prefix itself instead of reading `isComped`.
    vi.mocked(findActiveSubscription).mockResolvedValue(row() as never);
    const { body } = await getSubscription();
    const { subscription } = body as { subscription: Record<string, unknown> };

    for (const leaked of ['stripeCustomerId', 'stripeSubscriptionId', 'stripePriceId', 'oxyUserId']) {
      expect(Object.keys(subscription), `${leaked} reached the client`).not.toContain(leaked);
    }
    // The floor: the object is the subscription and not an empty one.
    expect(Object.keys(subscription).length).toBeGreaterThan(4);
  });

  it('marks a comped subscription, and only a comped one', async () => {
    vi.mocked(findActiveSubscription).mockResolvedValue(row() as never);
    expect(((await getSubscription()).body as { subscription: { isComped: boolean } }).subscription.isComped).toBe(false);

    vi.mocked(findActiveSubscription).mockResolvedValue(
      row({ stripeSubscriptionId: 'comp_oxy-user-1_alia' }) as never,
    );
    expect(((await getSubscription()).body as { subscription: { isComped: boolean } }).subscription.isComped).toBe(true);
  });

  it('answers null for an account with no subscription, and for an anonymous caller', async () => {
    vi.mocked(findActiveSubscription).mockResolvedValue(null);
    expect((await getSubscription()).body).toEqual({ subscription: null });

    // `null`, not `undefined`: the helper's default parameter would substitute a
    // signed-in user for `undefined` and the anonymous branch would never run.
    expect((await getSubscription(null)).body).toEqual({ subscription: null });
    expect(findActiveSubscription).toHaveBeenCalledTimes(1);
  });
});
