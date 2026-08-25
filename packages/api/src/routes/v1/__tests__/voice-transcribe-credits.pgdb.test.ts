import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * `POST /v1/voice/transcribe`, through the REAL handler against a REAL Postgres
 * server, for what happens to the credit it reserved.
 *
 * ## Two different bugs, and the second one is the subtle one
 *
 * The route reserved a credit and then had three exits. The outer `catch`
 * returned a 500 having neither charged nor refunded — an outright leak. The
 * other two, the global timeout and "every provider exhausted", called
 * `finalizeCredits(reservation, { totalTokens: 0 })` and read as free.
 *
 * They are not free. `calculateCreditsFromTokens` returns
 * `MIN_CREDITS_PER_REQUEST` for zero tokens, so settling a reservation at zero
 * CHARGES one credit — the same credit the reservation took. Both exits
 * therefore billed a full transcription for an audio clip that was never
 * transcribed, and the arithmetic that made it so is two files away from the
 * call that looks like it is asking for nothing.
 *
 * This module could not have refunded even if it had tried: it imported
 * `reserveCredits` and `finalizeCredits` and nothing else.
 */

vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child, v1: child, credits: child, providers: child, chat: child } };
});
vi.mock('../../../lib/chat-core.js', () => ({
  // `credits-manager` reads the credit multiplier from here.
  getAliaModel: vi.fn(async () => ({ creditMultiplier: 1 })),
}));
vi.mock('../../../lib/gateway-client.js', () => ({
  getModelMappingsForTier: vi.fn(async () => [{ provider: 'stub', modelId: 'whisper-stub' }]),
  callProviderAPI: vi.fn(async () => ({ text: 'transcribed words' })),
  getAliaModel: vi.fn(async () => ({ name: 'Alia' })),
}));
vi.mock('../../../lib/livekit-token.js', () => ({
  createVoiceToken: vi.fn(),
  isLiveKitConfigured: vi.fn(() => false),
  getLiveKitUrl: vi.fn(() => ''),
}));
vi.mock('../../../internal/providers/lib/voice-session-manager.js', () => ({
  voiceSessionManager: { createSession: vi.fn() },
}));
vi.mock('../../../lib/prompt-loader.js', () => ({ buildSystemPrompt: vi.fn(async () => '') }));
vi.mock('../../../lib/user-context.js', () => ({ buildUserContext: vi.fn(async () => ({ contextString: '' })) }));
vi.mock('../../../lib/plan-access.js', () => ({ getUserEntitlements: vi.fn(async () => ({ features: {}, allowedModelIds: [] })) }));
vi.mock('../../../lib/voice-usage.js', () => ({ getVoiceUsageSummary: vi.fn() }));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { userCredits } from '../../../db/schema/billing.js';
import { getOrCreateUserCredits } from '../../../db/billing/userCreditsRepository.js';
import { callProviderAPI, getModelMappingsForTier } from '../../../lib/gateway-client.js';
import { createVoiceToken, isLiveKitConfigured } from '../../../lib/livekit-token.js';
import { getUserEntitlements } from '../../../lib/plan-access.js';
import { voiceSessionManager } from '../../../internal/providers/lib/voice-session-manager.js';
import voiceRouter from '../voice.js';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

type Handler = (req: unknown, res: unknown) => Promise<unknown> | unknown;
interface RouteLayer {
  route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: Handler }> };
}

function transcribeHandler(): Handler {
  const stack = (voiceRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find(
    (entry) => entry.route?.path === '/transcribe' && entry.route.methods?.post === true,
  );
  expect(layer?.route, 'POST /transcribe is not mounted').toBeDefined();
  const handlers = layer?.route?.stack ?? [];
  expect(handlers.length, 'POST /transcribe has no handler').toBeGreaterThan(0);
  return handlers[handlers.length - 1].handle;
}

async function transcribe(userId: string): Promise<{ status: number; body: unknown }> {
  const recorded = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) { recorded.status = code; return res; },
    json(payload: unknown) { recorded.body = payload; return res; },
    send(payload: unknown) { recorded.body = payload; return res; },
    setHeader() { /* unused */ },
  };
  await transcribeHandler()(
    { user: { id: userId }, params: {}, query: {}, body: { audio: 'AAAA', format: 'audio/m4a' } },
    res,
  );
  return recorded;
}

/** Namespaced by pid — several `*.pgdb.test.ts` files share ONE database. */
const SUITE = `transcribe-${process.pid}`;
let seq = 0;

async function account(free: number, paid: number): Promise<string> {
  const id = `${SUITE}-${seq++}`;
  await getOrCreateUserCredits(db, id);
  await db.update(userCredits).set({ creditsFree: free, creditsPaid: paid }).where(eq(userCredits.id, id));
  return id;
}

async function rowExists(id: string): Promise<boolean> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  return row !== undefined;
}

async function balanceOf(id: string): Promise<{ free: number; paid: number }> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  if (!row) throw new Error(`no balance row for ${id}`);
  return { free: row.creditsFree, paid: row.creditsPaid };
}

describe('POST /v1/voice/transcribe — the reservation', () => {
  it('charges one credit for a transcription that succeeded', async () => {
    const userId = await account(100, 0);

    const res = await transcribe(userId);

    expect(res.body).toEqual({ text: 'transcribed words' });
    // The positive control: a route that refunded unconditionally would pass
    // every case below and fail this one.
    expect(await balanceOf(userId)).toEqual({ free: 99, paid: 0 });
  });

  it('charges NOTHING when every provider fails', async () => {
    const userId = await account(100, 0);
    vi.mocked(callProviderAPI).mockRejectedValue(new Error('provider down'));

    const res = await transcribe(userId);

    expect(res.status).toBe(503);
    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });

  it('charges NOTHING when there is no audio provider configured at all', async () => {
    const userId = await account(100, 0);
    vi.mocked(getModelMappingsForTier).mockResolvedValueOnce([]);

    const res = await transcribe(userId);

    expect(res.status).toBe(503);
    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });

  /**
   * The outright leak: an exception between the reservation and the settle.
   * `getModelMappingsForTier` throwing stands for any of them — it is the first
   * thing the route does after reserving.
   */
  it('gives the credit back when the route THROWS', async () => {
    const userId = await account(100, 0);
    vi.mocked(getModelMappingsForTier).mockRejectedValueOnce(new Error('catalogue unreachable'));

    const res = await transcribe(userId);

    expect(res.status).toBe(500);
    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });

  it('gives a paid-funded credit back to the PAID balance', async () => {
    const userId = await account(0, 100);
    vi.mocked(callProviderAPI).mockRejectedValue(new Error('provider down'));

    await transcribe(userId);

    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 100 });
  });

  it('debits nothing when the balance is empty', async () => {
    const userId = await account(0, 0);

    const res = await transcribe(userId);

    expect(res.status).toBe(402);
    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 0 });
  });
});

/**
 * `POST /v1/voice/token`, for the same broken invariant on an unrelated path.
 *
 * `createSession` reserves a MINUTE — fifty credits — through
 * `reserveVoiceCredits`, and like every other reserve it does not create the
 * balance row it spends from. This route never provisioned one, so a Pro
 * account that had never opened chat was told it had no credits when it opened
 * voice mode.
 *
 * The assertion is the ROW's EXISTENCE, not a balance, and that is deliberate:
 * `createSession` is mocked here (the real one dials LiveKit and a provider
 * socket), so nothing reserves and no balance moves. Provisioning is the entire
 * behaviour this route gains, so its trace is the only honest thing to measure.
 */
describe('POST /v1/voice/token — the payer balance row', () => {
  /** The token route's preconditions, which the transcribe suite mocks away. */
  function allowVoice(): void {
    vi.mocked(isLiveKitConfigured).mockReturnValue(true);
    vi.mocked(getUserEntitlements).mockResolvedValue({
      features: { 'voice-mode': true },
      allowedModelIds: ['alia-v1-voice'],
    } as unknown as Awaited<ReturnType<typeof getUserEntitlements>>);
    vi.mocked(voiceSessionManager.createSession).mockResolvedValue({
      roomName: 'voice-test',
      sessionId: 'sess-test',
    } as unknown as Awaited<ReturnType<typeof voiceSessionManager.createSession>>);
    vi.mocked(createVoiceToken).mockResolvedValue('livekit-token');
  }

  async function requestToken(userId: string): Promise<{ status: number; body: unknown }> {
    const recorded = { status: 200, body: undefined as unknown };
    const res = {
      status(code: number) { recorded.status = code; return res; },
      json(payload: unknown) { recorded.body = payload; return res; },
      send(payload: unknown) { recorded.body = payload; return res; },
      setHeader() { /* unused */ },
    };
    const stack = (voiceRouter as unknown as { stack: RouteLayer[] }).stack;
    const layer = stack.find(
      (entry) => entry.route?.path === '/token' && entry.route.methods?.post === true,
    );
    expect(layer?.route, 'POST /token is not mounted').toBeDefined();
    const handlers = layer?.route?.stack ?? [];
    await handlers[handlers.length - 1].handle(
      { user: { id: userId }, params: {}, query: {}, body: {} },
      res,
    );
    return recorded;
  }

  it('provisions a first-time caller rather than refusing them', async () => {
    allowVoice();
    // No `account()` — this id has no `user_credits` row at all.
    const userId = `${SUITE}-voice-fresh-${seq++}`;

    const res = await requestToken(userId);

    expect(res.body).toMatchObject({ roomName: 'voice-test' });
    expect(await rowExists(userId)).toBe(true);
  });

  /**
   * The positive control. Without it, "the row exists" would also pass on a
   * version that provisioned every caller of every route on this router, or on
   * one where some earlier test had already created the id.
   */
  it('leaves an existing balance untouched while doing it', async () => {
    allowVoice();
    const userId = await account(120, 30);

    await requestToken(userId);

    expect(await balanceOf(userId)).toEqual({ free: 120, paid: 30 });
  });
});
