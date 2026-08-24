import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `POST /v1/audio/generate` actually TAKES OFF THE BALANCE.
 *
 * ## The defect, and why this endpoint had it worst
 *
 * The handler says `~1 credit per 10 seconds` and handed `finalizeCredits`
 * `durationCredits * 50`. A credit is `CREDITS_CONFIG.TOKENS_PER_CREDIT` = 1000
 * tokens, so fifty tokens is a twentieth of one.
 *
 * On the speech endpoint that undercharges by a factor that grows with the
 * request. Here it does not grow at all: `duration` is capped at 120 seconds,
 * so `durationCredits` never exceeds 12 and the old expression never exceeded
 * 600 tokens — which never reaches the 1000 that make a credit. EVERY audio
 * generation, at every length, settled at `MIN_CREDITS_PER_REQUEST` = 1. A flat
 * rate of one credit, arrived at by accident rather than by decision.
 *
 * The 120-second case below is the one that proves the floor is not hiding the
 * bug: it is the longest clip the endpoint will make, it intends 12 credits,
 * and it was charged 1. The 5-second case is the control — it intends 1 and was
 * charged 1, so on its own it would pass against the broken code and measure
 * nothing.
 *
 * ## The charge happens after the response
 *
 * This route answers 202 and settles in `processAudioGeneration`, so asserting
 * the response proves nothing about the money. The suite waits for the job to
 * reach a terminal state — `markAudioJobCompleted` or `markAudioJobFailed` —
 * and reads the balance after that. The REAL `credits-manager.ts` runs
 * throughout, against an in-memory ledger.
 */

const H = vi.hoisted(() => ({
  /** The balance the real credits manager moves. */
  free: 0,
  paid: 0,
  /** Whether the generation provider answers or throws. */
  provider: 'ok' as 'ok' | 'throw',
  /** Resolved by whichever terminal state the background job reaches. */
  finish: () => {},
}));

/**
 * The DATABASE is what is faked, not the billing logic. Each of these four
 * mirrors its real SQL; the reservation, `calculateCreditsFromTokens` and the
 * refund-or-charge adjustment above them are the real module.
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

// This route passes no alias model, so the multiplier is 1 and the lookup never
// happens — stubbed so the AI SDK modules behind `chat-core` are not loaded.
vi.mock('../../../lib/chat-core.js', () => ({ getAliaModel: vi.fn(async () => null) }));

vi.mock('../../../lib/gateway-client.js', () => ({
  callProviderAPI: vi.fn(async () => {
    if (H.provider === 'throw') throw new Error('generation provider refused');
    // `extractAudioUrl` reads `audio_url` first.
    return { audio_url: 'https://example.invalid/generated.mp3' };
  }),
}));

vi.mock('../../../lib/synthesize-speech.js', () => ({ synthesizeSpeech: vi.fn(async () => null) }));
vi.mock('../../../lib/s3.js', () => ({ uploadToS3: vi.fn(async () => 'production/audio-gen/u1/generated.mp3') }));
vi.mock('../../../lib/stored-media.js', () => ({
  storedMediaUrl: vi.fn(() => 'https://api.example.invalid/media?signed'),
}));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../db/chat/messageRepository.js', () => ({
  findMessageAudioUrl: vi.fn(async () => null),
  setMessageAudioUrl: vi.fn(async () => undefined),
}));
vi.mock('../../../db/notifications/audioJobRepository.js', () => ({
  createAudioJob: vi.fn(async () => 'job-1'),
  findAudioJobStatus: vi.fn(async () => null),
  markAudioJobCompleted: vi.fn(async () => { H.finish(); }),
  markAudioJobFailed: vi.fn(async () => { H.finish(); }),
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

const STARTING_FREE = 500;

/**
 * Submits a generation and waits for the BACKGROUND job to settle, then answers
 * with the credits that left the balance.
 */
async function creditsChargedFor(body: Record<string, unknown>): Promise<number> {
  const terminal = new Promise<void>((resolve) => { H.finish = resolve; });
  const res = capturingRes();
  await handlerFor('/generate')({ user: { id: 'u1' }, body }, res, undefined);
  expect(res.statusCode).toBe(202);
  await terminal;
  return STARTING_FREE - (H.free + H.paid);
}

beforeEach(() => {
  H.free = STARTING_FREE;
  H.paid = 0;
  H.provider = 'ok';
  // The processor downloads the generated clip before uploading it. Stubbed
  // rather than mocked at the module boundary because the route calls the
  // global directly.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  })));
});

describe('POST /v1/audio/generate charges the rate it states', () => {
  it('charges 12 credits for a 120-second clip — the longest it will make', async () => {
    // 120 / 10 = 12 credits intended. Before the fix this settled 1: 12 * 50 =
    // 600 tokens, which never reaches the 1000 that make a credit. Because 120
    // is the cap, this is the WORST the old code could ever charge, and it is
    // still the floor.
    expect(await creditsChargedFor({ prompt: 'a drum loop', seconds_total: 120 })).toBe(12);
  });

  it('charges 3 credits for the default 30-second clip', async () => {
    // No `seconds_total`, so the handler's own default of 30 applies.
    expect(await creditsChargedFor({ prompt: 'a drum loop' })).toBe(3);
  });

  it('still charges 1 credit for a 5-second clip, which is where the two agree', async () => {
    // The control, and the reason the other two exist. `max(1, ceil(0.5))` is 1
    // by the rate AND 1 by MIN_CREDITS_PER_REQUEST, so this case passes against
    // the broken code too. It is here to pin the floor the fix must not move.
    expect(await creditsChargedFor({ prompt: 'a drum loop', seconds_total: 5 })).toBe(1);
  });

  it('takes nothing at all when the generation provider fails', async () => {
    // The reservation debits at submission, and the background job owns it from
    // the 202 onward — so a failure there must give it back.
    H.provider = 'throw';
    const terminal = new Promise<void>((resolve) => { H.finish = resolve; });
    const res = capturingRes();
    await handlerFor('/generate')({ user: { id: 'u1' }, body: { prompt: 'a drum loop', seconds_total: 120 } }, res, undefined);

    expect(res.statusCode).toBe(202);
    await terminal;
    expect(H.free + H.paid).toBe(STARTING_FREE);
  });
});
