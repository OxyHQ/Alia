import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The route must actually USE the per-provider body, and refund what it fails.
 *
 * `image-providers.test.ts` proves the translation is correct in isolation. A
 * correct translation nothing calls is green and inert, so this drives the real
 * handler and reads what reached `callProviderAPI` — the entrypoint assertion.
 *
 * Both properties are pinned here because both were broken on 2026-08-23 and
 * both are invisible from the outside: xAI answers 400/422 with an EMPTY body,
 * and an over-billed failure looks exactly like a failure.
 */

const H = vi.hoisted(() => ({
  /** Every body handed to `callProviderAPI`, in order, with its provider. */
  sent: [] as Array<{ provider: string; body: Record<string, unknown> }>,
  calls: [] as string[],
  /** Providers whose call succeeds; everything else throws. */
  succeeds: new Set<string>(),
  mappings: [] as Array<{ provider: string; modelId: string }>,
}));

vi.mock('../../../lib/gateway-client.js', () => ({
  getModelMappingsForTier: vi.fn(async () => H.mappings),
  callProviderAPI: vi.fn(async (opts: { provider: string; body: Record<string, unknown> }) => {
    H.sent.push({ provider: opts.provider, body: opts.body });
    if (!H.succeeds.has(opts.provider)) throw new Error(`${opts.provider} refused`);
    return { data: [{ url: 'https://example.invalid/i.png' }] };
  }),
}));

vi.mock('../../../lib/credits-manager.js', () => ({
  reserveCredits: vi.fn(async () => {
    H.calls.push('reserve');
    return { userId: 'u1', creditsReserved: 5, initialFreeCredits: 50, initialPaidCredits: 0 };
  }),
  finalizeCredits: vi.fn(async (_r: unknown, u: { totalTokens?: number }) => {
    H.calls.push(`finalize(${u?.totalTokens ?? 0})`);
    return { creditsCharged: 5, creditsRemaining: 45 };
  }),
  refundReservation: vi.fn(async () => { H.calls.push('refund'); }),
}));

vi.mock('../../../lib/user-credits-helpers.js', () => ({ getOrCreateUserCredits: vi.fn(async () => ({})) }));
vi.mock('../../../lib/s3.js', () => ({ uploadToS3: vi.fn(async () => 'https://example.invalid/s3.png') }));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../lib/logger.js', () => ({
  log: new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn() }) }),
}));

const { default: imagesRouter } = await import('../images.js');

interface RouteLayer {
  route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: (a: unknown, b: unknown, c: unknown) => Promise<void> | void }> };
}
function handlerFor(path: string) {
  const stack = (imagesRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((e) => e.route?.path === path && e.route.methods?.post);
  if (!layer?.route) throw new Error(`POST ${path} not mounted`);
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
const req = { user: { id: 'u1' }, body: { prompt: 'a red apple' } };

beforeEach(() => {
  H.sent.length = 0;
  H.calls.length = 0;
  H.succeeds = new Set();
  H.mappings = [{ provider: 'xai', modelId: 'grok-imagine-image' }];
});

describe('POST /v1/images/generations', () => {
  it('sends xAI a body WITHOUT size or quality', async () => {
    H.succeeds.add('xai');
    const res = capturingRes();
    await handlerFor('/generations')(req, res, undefined);

    expect(H.sent).toHaveLength(1);
    expect(Object.keys(H.sent[0].body).sort()).toEqual(['model', 'n', 'prompt', 'response_format']);
    expect(res.statusCode).toBe(200);
  });

  it('still sends the full OpenAI body to a provider that takes it', async () => {
    // The control. If the route stripped unconditionally, the assertion above
    // would pass while every existing mapping silently lost two parameters.
    H.mappings = [{ provider: 'openai', modelId: 'dall-e-3' }];
    H.succeeds.add('openai');
    const res = capturingRes();
    await handlerFor('/generations')(req, res, undefined);

    expect(H.sent[0].body.size).toBe('1024x1024');
    expect(H.sent[0].body.quality).toBe('standard');
  });

  it('does not leak one provider\'s stripped body into the next attempt', async () => {
    // Only visible on the SECOND attempt, which is why it is driven through a
    // real failover rather than asserted on a single call.
    H.mappings = [
      { provider: 'xai', modelId: 'grok-imagine-image' },
      { provider: 'openai', modelId: 'dall-e-3' },
    ];
    H.succeeds.add('openai');
    const res = capturingRes();
    await handlerFor('/generations')(req, res, undefined);

    expect(H.sent.map((s) => s.provider)).toEqual(['xai', 'openai']);
    expect(H.sent[0].body.size).toBeUndefined();
    expect(H.sent[1].body.size).toBe('1024x1024');
    expect(res.statusCode).toBe(200);
  });

  it('refunds — and does NOT bill — when every provider refuses', async () => {
    const res = capturingRes();
    await handlerFor('/generations')(req, res, undefined);

    expect(H.calls).toEqual(['reserve', 'refund']);
    expect(H.calls.some((c) => c.startsWith('finalize'))).toBe(false);
    expect(res.statusCode).toBe(503);
  });

  it('still BILLS a successful generation', async () => {
    // Vacuity floor for the refund assertions above.
    H.succeeds.add('xai');
    const res = capturingRes();
    await handlerFor('/generations')(req, res, undefined);

    expect(H.calls.some((c) => c.startsWith('finalize('))).toBe(true);
    expect(H.calls).not.toContain('refund');
  });
});
