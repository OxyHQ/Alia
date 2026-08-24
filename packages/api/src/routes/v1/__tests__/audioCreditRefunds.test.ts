import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A failed audio request must GIVE THE CREDIT BACK.
 *
 * `reserveCredits` debits immediately, so an exit that neither charges nor
 * refunds keeps the caller's credit. `POST /v1/audio/speech` had six such exits
 * in two flavours, both observed in production on 2026-08-23:
 *
 *  - Four called `finalizeCredits(reservation, {totalTokens: 0})`, and
 *    `calculateCreditsFromTokens` returns `MIN_CREDITS_PER_REQUEST` for zero
 *    tokens. So a request that produced no audio BILLED the minimum. With no
 *    TTS provider holding a key, every one of the chain's four mappings failed
 *    with `Provider API exhausted` and the caller paid for a request that never
 *    reached a provider at all.
 *  - Two were `catch` blocks that could not see `reservation`, because it was
 *    declared inside the `try`. Those neither charged nor refunded, which is
 *    the same debit wearing a quieter failure.
 *
 * The success case is asserted alongside, and is not decoration: without it a
 * mutation that refunds unconditionally would satisfy every other assertion
 * here while giving away paid work for free.
 */

const H = vi.hoisted(() => ({
  calls: [] as string[],
  /** What `synthesizeSpeech` does this run. */
  synth: 'ok' as 'ok' | 'null' | 'throw',
}));

/**
 * `CREDITS_CONFIG` is the REAL one, not a copy.
 *
 * The route states its price in credits and hands `finalizeCredits` the
 * equivalent in tokens, so it reads `TOKENS_PER_CREDIT` from here. A mock that
 * omitted the export made that read `undefined` and threw inside the handler —
 * and a mock that restated the number would let the constant and the conversion
 * drift apart silently, which is the whole class of bug this file exists for.
 */
vi.mock('../../../lib/credits-manager.js', async () => ({
  CREDITS_CONFIG: (
    await vi.importActual<typeof import('../../../lib/credits-manager.js')>(
      '../../../lib/credits-manager.js',
    )
  ).CREDITS_CONFIG,
  reserveCredits: vi.fn(async () => {
    H.calls.push('reserve');
    return { userId: 'u1', creditsReserved: 1, initialFreeCredits: 10, initialPaidCredits: 0 };
  }),
  finalizeCredits: vi.fn(async (_r: unknown, usage: { totalTokens?: number }) => {
    H.calls.push(`finalize(${usage?.totalTokens ?? 0})`);
    return { creditsCharged: 1, creditsRemaining: 9 };
  }),
  refundReservation: vi.fn(async () => { H.calls.push('refund'); }),
}));

vi.mock('../../../lib/synthesize-speech.js', () => ({
  synthesizeSpeech: vi.fn(async () => {
    H.calls.push('synthesize');
    if (H.synth === 'throw') throw new Error('upstream exploded');
    if (H.synth === 'null') return null;
    return { audio: Buffer.from('fake-audio'), format: 'mp3' };
  }),
}));

vi.mock('../../../lib/user-credits-helpers.js', () => ({ getOrCreateUserCredits: vi.fn(async () => ({})) }));
vi.mock('../../../lib/s3.js', () => ({
  // An upload answers with the object's KEY now, never an address.
  uploadToS3: vi.fn(async () => 'production/tts/user-1/speech-abc.mp3'),
}));

// This suite is about the credit ledger, not about link signing — but the
// success path cannot answer without an address, so the renderer is stubbed to
// produce one. A `null` here would turn every success case into a 500 and the
// suite would be asserting the wrong thing.
vi.mock('../../../lib/stored-media.js', () => ({
  storedMediaUrl: vi.fn(() => 'https://api.example.invalid/media?signed'),
}));
vi.mock('../../../lib/gateway-client.js', () => ({ callProviderAPI: vi.fn(async () => null) }));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../db/chat/messageRepository.js', () => ({
  findMessageAudioUrl: vi.fn(async () => null),
  setMessageAudioUrl: vi.fn(async () => undefined),
}));
vi.mock('../../../db/notifications/audioJobRepository.js', () => ({
  createAudioJob: vi.fn(async () => undefined),
  findAudioJobStatus: vi.fn(async () => null),
  markAudioJobCompleted: vi.fn(async () => undefined),
  markAudioJobFailed: vi.fn(async () => undefined),
}));
vi.mock('../../../socket.js', () => ({ emitAudioJobUpdate: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({
  log: new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn() }) }),
}));

const { default: audioRouter } = await import('../audio.js');

interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: unknown) => Promise<void> | void }>;
  };
}

function handlerFor(path: string) {
  const stack = (audioRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((e) => e.route?.path === path && e.route.methods?.post);
  if (!layer?.route) throw new Error(`POST ${path} not mounted on the audio router`);
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

const speechReq = { user: { id: 'u1' }, body: { input: 'hola', voice: 'nova' } };

beforeEach(() => {
  H.calls.length = 0;
  H.synth = 'ok';
});

describe('POST /v1/audio/speech settles the reservation on every exit', () => {
  it('refunds — and does NOT bill — when no provider produced audio', async () => {
    H.synth = 'null';
    const res = capturingRes();
    await handlerFor('/speech')(speechReq, res, undefined);

    expect(H.calls).toEqual(['reserve', 'synthesize', 'refund']);
    // Named explicitly: a zero-token finalize is the BUG, not a neutral no-op.
    expect(H.calls.some((c) => c.startsWith('finalize'))).toBe(false);
    expect(res.statusCode).toBe(503);
  });

  it('refunds when the synthesis path THROWS, which the catch could not do', async () => {
    H.synth = 'throw';
    const res = capturingRes();
    await handlerFor('/speech')(speechReq, res, undefined);

    expect(H.calls).toEqual(['reserve', 'synthesize', 'refund']);
    expect(res.statusCode).toBe(500);
  });

  it('still BILLS the success path, and refunds nothing', async () => {
    const res = capturingRes();
    await handlerFor('/speech')(speechReq, res, undefined);

    expect(H.calls).toContain('reserve');
    expect(H.calls.some((c) => c.startsWith('finalize('))).toBe(true);
    expect(H.calls).not.toContain('refund');
    expect(res.statusCode).toBe(200);
  });

  it('takes no reservation at all when the input is rejected up front', async () => {
    // The floor. If the handler reserved before validating, an empty body would
    // cost a credit and these refund assertions would be measuring a bug that
    // starts one step earlier.
    const res = capturingRes();
    await handlerFor('/speech')({ user: { id: 'u1' }, body: { input: '   ' } }, res, undefined);

    expect(H.calls).toEqual([]);
    expect(res.statusCode).toBe(400);
  });
});
