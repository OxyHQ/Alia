import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `POST /v1/audio/speech` actually TAKES OFF THE BALANCE.
 *
 * ## The defect
 *
 * The handler states its price in CREDITS — `~1 credit per 200 chars`, as
 * `charCredits = max(1, ceil(input.length / 200))` — and then handed that
 * figure to `finalizeCredits`, which settles in TOKENS, multiplied by 50. A
 * credit is `CREDITS_CONFIG.TOKENS_PER_CREDIT` = 1000 tokens, so fifty tokens
 * is a twentieth of a credit and the whole charge came out as
 * `ceil(charCredits / 20)`.
 *
 * ## Why the length matters, and why a short input proves nothing
 *
 * `calculateCreditsFromTokens` floors at `MIN_CREDITS_PER_REQUEST` = 1. A
 * 200-character request intends 1 credit and the broken arithmetic also
 * produces 1 — through the floor, for the wrong reason. So does every input up
 * to 4,000 characters. A test written against a short string is GREEN BEFORE
 * AND AFTER the fix and measures nothing at all, which is exactly how this
 * survived: by hand, the endpoint looks right.
 *
 * 4,000 characters is the case that separates them, and it is chosen rather
 * than picked: it is the largest round length inside the handler's own 4,096
 * character cap, it intends 20 credits, and it was charged 1. The 200-character
 * case is asserted alongside as the positive control — it pins the floor the
 * fix must not disturb, and on its own it is the vacuous test described above.
 *
 * ## Why this suite does not stub `finalizeCredits`
 *
 * The sibling suites mock the whole credits manager and read the `totalTokens`
 * the route passed. That asserts an INPUT, and the input was never the
 * question — 50 tokens per credit is a perfectly well-formed argument. Here the
 * REAL `credits-manager.ts` runs, reserving and settling against an in-memory
 * balance, and the assertion is the number of credits that left it.
 */

const H = vi.hoisted(() => ({
  /** The balance the real credits manager moves. */
  free: 0,
  paid: 0,
  /** What `synthesizeSpeech` answers this run. */
  synth: 'ok' as 'ok' | 'null',
}));

/**
 * The DATABASE is what is faked, not the billing logic.
 *
 * These four statements are the whole of the credits manager's storage, and
 * each mirrors its real SQL: `spendCreditsFreeFirst` takes from the free
 * balance first and refuses outright when the total will not cover the amount,
 * exactly as its `greatest(...)` update and its `free + paid >= amount` guard
 * do. Everything above them — the reservation, `calculateCreditsFromTokens`,
 * the refund-or-charge adjustment — is the real module.
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
// Neither route passes an alias model, so the lookup never happens and the
// multiplier is 1 — stubbed so the AI SDK provider modules behind `chat-core`
// are not loaded to prove it.
vi.mock('../../../lib/chat-core.js', () => ({ getAliaModel: vi.fn(async () => null) }));

vi.mock('../../../lib/synthesize-speech.js', () => ({
  synthesizeSpeech: vi.fn(async () => {
    if (H.synth === 'null') return null;
    return { audio: Buffer.from('fake-audio'), format: 'mp3' };
  }),
}));

vi.mock('../../../lib/s3.js', () => ({
  uploadToS3: vi.fn(async () => 'production/tts/user-1/speech-abc.mp3'),
}));
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

const STARTING_FREE = 500;

/** Runs the endpoint and answers with the credits that left the balance. */
async function creditsChargedFor(input: string): Promise<number> {
  const res = capturingRes();
  await handlerFor('/speech')({ user: { id: 'u1' }, body: { input, voice: 'nova' } }, res, undefined);
  if (res.statusCode !== 200) throw new Error(`speech answered ${res.statusCode}, so no charge was settled`);
  return STARTING_FREE - (H.free + H.paid);
}

beforeEach(() => {
  H.free = STARTING_FREE;
  H.paid = 0;
  H.synth = 'ok';
});

describe('POST /v1/audio/speech charges the rate it states', () => {
  it('charges 20 credits for 4,000 characters — the length where the bug is visible', async () => {
    // 4,000 / 200 = 20 credits intended. Before the fix this settled 1: the
    // handler sent 20 * 50 = 1,000 tokens, which is one credit's worth.
    expect(await creditsChargedFor('a'.repeat(4000))).toBe(20);
  });

  it('charges 5 credits for 1,000 characters', async () => {
    // Mid-range, and below the point where the broken arithmetic could clear
    // the floor at all: 5 * 50 = 250 tokens settled at MIN_CREDITS_PER_REQUEST.
    expect(await creditsChargedFor('b'.repeat(1000))).toBe(5);
  });

  it('charges 21 credits at the endpoint\'s own 4,096-character cap', async () => {
    // ceil(4096 / 200) = 21. The only input the old arithmetic charged more
    // than the floor for — 1,050 tokens, so 2 credits against the intended 21.
    expect(await creditsChargedFor('c'.repeat(4096))).toBe(21);
  });

  it('still charges 1 credit for 200 characters, which is where the two agree', async () => {
    // The positive control, and the reason the other three exist. This case
    // passes against the broken code as well — through MIN_CREDITS_PER_REQUEST
    // rather than through the rate — so alone it would be a vacuous test. It is
    // here to pin the floor, which the fix must leave exactly where it was.
    expect(await creditsChargedFor('d'.repeat(200))).toBe(1);
  });

  it('takes nothing at all when no provider produced audio', async () => {
    // The reservation debits immediately, so "charged nothing" is a claim about
    // the refund having happened, not about a charge having been skipped.
    H.synth = 'null';
    const res = capturingRes();
    await handlerFor('/speech')({ user: { id: 'u1' }, body: { input: 'e'.repeat(4000) } }, res, undefined);

    expect(res.statusCode).toBe(503);
    expect(H.free + H.paid).toBe(STARTING_FREE);
  });
});
