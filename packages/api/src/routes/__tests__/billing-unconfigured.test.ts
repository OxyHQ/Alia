import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A deployment without Stripe answers billing requests with 503, not 500.
 *
 * Production ran without `STRIPE_SECRET_KEY` and every checkout attempt logged
 * as an unhandled server error with a stack trace. Missing configuration is a
 * fact about the environment; the client gets a code it can act on and the log
 * gets a warning.
 */

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  optionalAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  oxyClient: { users: { get: vi.fn() } },
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
  getAllRoutingProfiles: vi.fn(),
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

import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import router from '../billing.js';

type Handler = (req: Record<string, unknown>, res: MockResponse) => Promise<unknown>;

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

function handlerFor(path: string): Handler {
  const layers = (
    router as unknown as {
      stack: {
        route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] };
      }[];
    }
  ).stack;
  const layer = layers.find((l) => l.route?.path === path && l.route.methods.post);
  if (!layer?.route) throw new Error(`no handler for POST ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const original = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.STRIPE_SECRET_KEY;
  vi.mocked(getOrCreateUserCredits).mockResolvedValue({ stripeCustomerId: null } as never);
});

afterEach(() => {
  if (original === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = original;
});

describe('billing without STRIPE_SECRET_KEY', () => {
  it('answers the portal with 503 billing_unavailable', async () => {
    const res = makeRes();
    await handlerFor('/portal')(
      { user: { id: 'u1' }, body: { returnUrl: 'https://alia.onl' } },
      res,
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'billing_unavailable' });
  });
});

it('refuses legacy financial writes for an explicitly declared native annual plan before contacting a provider', async () => {
  const previous = process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER;
  process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER = JSON.stringify({
    productId: 'alia',
    quotaKey: 'credits',
    unit: 'alia_credit',
    combination: 'maximum',
    planId: 'go',
    individualOffers: [
      { offerId: 'pro-year', offerVersion: 1, planId: 'pro', billingPeriod: 'annual' },
    ],
  });
  try {
    for (const path of ['/checkout/subscription', '/subscription/change-plan']) {
      const res = makeRes();
      await handlerFor(path)(
        { user: { id: 'u1' }, body: { planId: 'pro', billingPeriod: 'annual' } },
        res,
      );
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ error: 'use_oxy_product_checkout' });
    }
    expect(getOrCreateUserCredits).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER;
    else process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER = previous;
  }
});
