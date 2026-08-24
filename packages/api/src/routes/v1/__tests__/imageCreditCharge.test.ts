import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `POST /v1/images/generations` actually TAKES OFF THE BALANCE.
 *
 * ## The defect
 *
 * The handler says `~5 credits per image` and then handed `finalizeCredits` a
 * hardcoded 250 tokens. 250 is that same 5 pre-multiplied by 50, and a credit
 * is `CREDITS_CONFIG.TOKENS_PER_CREDIT` = 1000 tokens — so it settled at
 * `ceil(250 / 1000)`, floored to `MIN_CREDITS_PER_REQUEST` = 1. Every image
 * ever generated was charged a fifth of its stated price, flat and
 * unconditional.
 *
 * ## Why there is no boundary to be careful about here
 *
 * Unlike the speech endpoint, this charge does not vary with the input, so
 * there is no short-input case that agrees by accident. One assertion covers
 * it: 5, where the old code produced 1. The `n` case and the refund case are
 * the controls — the first pins the decision NOT to bill per requested image,
 * the second pins that a failed generation still costs nothing.
 *
 * ## Why this suite does not stub `finalizeCredits`
 *
 * `imageProviderBody.test.ts` mocks the whole credits manager and reads the
 * `totalTokens` the route passed, which asserts an INPUT — and the input was
 * never the question, since 250 is a perfectly well-formed token count. Here
 * the REAL `credits-manager.ts` runs, reserving and settling against an
 * in-memory balance, and the assertion is the number of credits that left it.
 */

const H = vi.hoisted(() => ({
  /** The balance the real credits manager moves. */
  free: 0,
  paid: 0,
  /** Providers whose call succeeds; everything else throws. */
  succeeds: new Set<string>(),
  mappings: [] as Array<{ provider: string; modelId: string }>,
}));

/**
 * The DATABASE is what is faked, not the billing logic.
 *
 * Each of these four mirrors its real SQL: `spendCreditsFreeFirst` takes from
 * the free balance first and refuses outright when the total will not cover the
 * amount, exactly as its `greatest(...)` update and its `free + paid >= amount`
 * guard do. Everything above them — the reservation,
 * `calculateCreditsFromTokens`, the refund-or-charge adjustment — is real.
 */
vi.mock('../../../db/billing/userCreditsRepository.js', () => {
  const row = () => ({ id: 'u1', creditsFree: H.free, creditsPaid: H.paid });
  return {
    getOrCreateUserCredits: vi.fn(async () => row()),
    findUserCredits: vi.fn(async () => row()),
    refreshFreeCreditsIfDue: vi.fn(async () => row()),
    spendCreditsFreeFirst: vi.fn(async (_db: unknown, _id: string, amount: number) => {
      if (H.free + H.paid < amount) return null;
      const fromFree = Math.min(H.free, amount);
      H.free -= fromFree;
      H.paid -= amount - fromFree;
      return row();
    }),
    addCredits: vi.fn(async (_db: unknown, _id: string, amount: number, type: 'free' | 'paid') => {
      if (type === 'free') H.free += amount;
      else H.paid += amount;
      return row();
    }),
    zeroCredits: vi.fn(async () => {
      H.free = 0;
      H.paid = 0;
      return row();
    }),
  };
});

// `credits-manager.ts` reaches for a model's `credit_multiplier` through this.
// This route passes no alias model, so the lookup never happens and the
// multiplier is 1 — stubbed so the AI SDK provider modules behind `chat-core`
// are not loaded to prove it.
vi.mock('../../../lib/chat-core.js', () => ({ getAliaModel: vi.fn(async () => null) }));

vi.mock('../../../lib/gateway-client.js', () => ({
  getModelMappingsForTier: vi.fn(async () => H.mappings),
  callProviderAPI: vi.fn(async (opts: { provider: string }) => {
    if (!H.succeeds.has(opts.provider)) throw new Error(`${opts.provider} refused`);
    return { data: [{ url: 'https://example.invalid/i.png' }] };
  }),
}));

vi.mock('../../../lib/s3.js', () => ({ uploadToS3: vi.fn(async () => 'production/images/u1/generated.png') }));
vi.mock('../../../lib/stored-media.js', () => ({
  storedMediaUrl: vi.fn(() => 'https://api.example.invalid/media?signed'),
}));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../lib/logger.js', () => ({
  log: new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn() }) }),
}));

const { default: imagesRouter } = await import('../images.js');

interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: unknown) => Promise<void> | void }>;
  };
}

function handlerFor(path: string) {
  const stack = (imagesRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((e) => e.route?.path === path && e.route.methods?.post);
  if (!layer?.route) throw new Error(`POST ${path} not mounted on the images router`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function capturingRes() {
  const res = {
    statusCode: 200 as number,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res;
}

const STARTING_FREE = 500;

/** Runs the endpoint and answers with the credits that left the balance. */
async function creditsChargedFor(body: Record<string, unknown>): Promise<number> {
  const res = capturingRes();
  await handlerFor('/generations')({ user: { id: 'u1' }, body }, res, undefined);
  if (res.statusCode !== 200) throw new Error(`generations answered ${res.statusCode}, so no charge was settled`);
  return STARTING_FREE - (H.free + H.paid);
}

beforeEach(() => {
  H.free = STARTING_FREE;
  H.paid = 0;
  H.succeeds = new Set(['xai']);
  H.mappings = [{ provider: 'xai', modelId: 'grok-imagine-image' }];
});

describe('POST /v1/images/generations charges the price it states', () => {
  it('charges 5 credits for a generated image', async () => {
    // The whole bug in one number. Before the fix this settled 1, because the
    // handler sent 250 tokens — a quarter of a credit, floored to the minimum.
    expect(await creditsChargedFor({ prompt: 'a red apple' })).toBe(5);
  });

  it('charges 5 credits, not 20, when the caller asks for n images', async () => {
    // The handler reads `data[0]` and answers with ONE url whatever `n` says,
    // so 5 is the price of what it actually delivers. Asserted rather than left
    // implicit: `n * 5` is the obvious-looking reading of "~5 credits per
    // image" and it would bill for images that are never returned.
    expect(await creditsChargedFor({ prompt: 'a red apple', n: 4 })).toBe(5);
  });

  it('takes nothing at all when every provider refuses', async () => {
    // The reservation debits immediately, so "charged nothing" is a claim about
    // the refund having happened, not about a charge having been skipped.
    H.succeeds = new Set();
    const res = capturingRes();
    await handlerFor('/generations')({ user: { id: 'u1' }, body: { prompt: 'a red apple' } }, res, undefined);

    expect(res.statusCode).toBe(503);
    expect(H.free + H.paid).toBe(STARTING_FREE);
  });
});
