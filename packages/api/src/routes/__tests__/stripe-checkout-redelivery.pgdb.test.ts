import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiDatabase } from '../../db/index.js';

/**
 * A redelivered `checkout.session.completed` credits the customer ONCE.
 *
 * ## What was wrong
 *
 * The credit-purchase branch of `handleCheckoutCompleted` called `addCredits`
 * and THEN `insertTransaction`. The dedup lock is the unique index on
 * `transactions.stripe_payment_intent_id`, so it was consulted only after the
 * money had already moved: every redelivery added the full amount again and
 * then logged "Duplicate checkout event, skipping", which reads like nothing
 * happened.
 *
 * Stripe redelivers on any non-2xx or timeout, and this same handler can still
 * throw further down its subscription fallback — so this was not hypothetical.
 * The subscription path a hundred lines below always had the ordering right,
 * and its own comment calls it "the single most dangerous line in this port …
 * otherwise every webhook redelivery would credit the customer again". The two
 * paths simply disagreed, and only one of them was written down.
 *
 * ## Why this runs against a real server
 *
 * The fix IS an ordering with respect to a unique index, and a unique index has
 * no mocked counterpart: a fake `insertTransaction` that throws on the second
 * write would do so whichever order the two statements were in, so the test
 * would pass against the bug it exists to catch. `getOrCreateUserCredits`,
 * `addCredits` and `insertTransaction` all run for real here.
 *
 * Only Stripe is a double — signature verification is not the subject — and the
 * route handler is invoked directly, which is how the other route suites in
 * this directory work rather than mounting a server.
 */

const EVENTS: unknown[] = [];

vi.mock('stripe', () => {
  class FakeStripe {
    webhooks = { constructEvent: () => EVENTS.shift() };
  }
  return { default: FakeStripe };
});

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      credits: child,
      general: child,
      agents: child,
      chat: child,
      webhook: child,
      v1: child,
      providers: child,
    },
  };
});

// Loaded at module scope by the router for its plan catalogue; nothing on this
// file's path calls into it.
vi.mock('../../lib/gateway-client.js', () => ({
  getPlans: vi.fn(async () => []),
  getCreditPackages: vi.fn(async () => []),
  getFeatures: vi.fn(async () => []),
  getPlanFeatures: vi.fn(async () => []),
  getAllRoutingProfiles: vi.fn(async () => []),
}));

const { closePostgres, connectPostgres } = await import('../../db/index.js');
const { getOrCreateUserCredits } = await import('../../db/billing/userCreditsRepository.js');
const { default: billingRouter } = await import('../billing.js');

const USER = `oxy-buyer-${Math.random().toString(36).slice(2, 10)}`;
const PAYMENT_INTENT = `pi_${Math.random().toString(36).slice(2, 12)}`;
const CREDITS = 5000;

let db: ApiDatabase;

const webhookLayer = billingRouter.stack.find(
  (candidate) => candidate.route?.path === '/webhook',
);
const foundHandler = webhookLayer?.route?.stack.at(-1)?.handle;
if (!foundHandler) throw new Error('billing router no longer exposes POST /webhook');
const webhookHandler = foundHandler as (req: never, res: never, next: () => void) => Promise<void>;

function checkoutEvent() {
  return {
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_test',
        payment_intent: PAYMENT_INTENT,
        amount_total: 999,
        currency: 'usd',
        metadata: { type: 'credit_purchase', userId: USER, credits: String(CREDITS) },
      },
    },
  };
}

/** Deliver one webhook, and report the status the route answered with. */
async function deliver(): Promise<number> {
  EVENTS.push(checkoutEvent());
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
    send() {
      return this;
    },
  };
  await webhookHandler(
    { headers: { 'stripe-signature': 'test' }, body: Buffer.from('{}') } as never,
    res as never,
    () => undefined,
  );
  return status;
}

async function paidBalance(): Promise<number> {
  const row = await getOrCreateUserCredits(db, USER);
  return row.creditsPaid;
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
  await getOrCreateUserCredits(db, USER);
});

afterAll(async () => {
  await closePostgres();
});

describe('a redelivered credit purchase', () => {
  it('credits the customer once, however many times Stripe sends it', async () => {
    const before = await paidBalance();

    expect(await deliver()).toBe(200);
    const afterFirst = await paidBalance();
    expect(afterFirst).toBe(before + CREDITS);

    // The same event again — same `payment_intent`, which is the dedup key.
    // Against the pre-fix ordering this added another 5 000 and answered 200.
    expect(await deliver()).toBe(200);
    expect(await paidBalance()).toBe(afterFirst);

    // A third, because the property is "once", not "at most twice".
    expect(await deliver()).toBe(200);
    expect(await paidBalance()).toBe(afterFirst);
  });
});
