import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * `VoiceSessionManager.createSession`, against a REAL Postgres server, for the
 * credits it reserves before it has a session at all.
 *
 * ## A voice reservation is a hundred credits, not one
 *
 * `reserveVoiceCredits(userId, 1, model, costPerMinute)` reserves a MINUTE:
 * `1 × 0.05 × 1000 = 100` credits once `profile:v1-voice`'s 2× multiplier is
 * applied, taken before the LiveKit room exists and before the provider socket
 * is opened. Every step after that can fail — the
 * provider refusing the connection is the ordinary case — and each failure was
 * answered by `closeSession`, which FINALIZES at the elapsed duration.
 *
 * That is not a leak of all hundred; it is a charge of one credit for a call
 * that never happened, because `calculateCreditsFromMinutes` floors at
 * `MIN_CREDITS_PER_REQUEST`. A session that never became active consumed no
 * provider time, so the whole reservation belongs back with the caller.
 *
 * The outright leak is earlier and larger: a throw between the reservation and
 * the session being registered in the manager's map leaves the hundred with
 * nobody holding a handle to them.
 *
 * Everything outside the credits — LiveKit, the provider socket, the model
 * resolver — is stubbed. The balance is real, and so is the PRICE: the
 * multiplier comes from `lib/routing/presets.ts`, a static table, so there is
 * nothing left to stub and the figures below are the ones production moves.
 */

vi.mock('../../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { providers: child, general: child, credits: child, chat: child, v1: child, agents: child } };
});
vi.mock('../model-resolver.js', () => ({
  resolveAliaModel: vi.fn(async () => ({
    provider: 'stub',
    modelId: 'voice-stub',
    keyConfig: { keyId: 'key-1' },
    aliaModel: { tier: 'v1-voice' },
  })),
}));
vi.mock('../alia-models.js', () => ({
  getModelMappingsForTier: vi.fn(() => [{ provider: 'stub', modelId: 'voice-stub', costPerMinute: 0.05 }]),
}));
const connect = vi.fn();
vi.mock('../providers/index.js', () => ({
  providers: { stub: { voice: { connect: (...args: unknown[]) => connect(...args) } } },
}));
vi.mock('../../../../lib/livekit-token.js', () => ({
  createAgentToken: vi.fn(async () => 'agent-token'),
  createVoiceRoom: vi.fn(async () => undefined),
  deleteVoiceRoom: vi.fn(async () => undefined),
  getLiveKitInternalUrl: vi.fn(() => 'ws://livekit'),
}));
/**
 * Identities whose `join` must fail. Keyed by the identity the manager
 * constructs the bridge with — `alia-agent` for the primary, `alia-cohost` for
 * the second participant — so a cohost join can fail while the primary's
 * succeeds, which is the only interesting arrangement.
 */
const bridgeJoinFailures = new Set<string>();

vi.mock('../../../../lib/livekit-agent.js', () => ({
  LiveKitAgentBridge: class {
    onUserAudioFrame: unknown = null;
    onClientData: unknown = null;
    onUserDisconnected: unknown = null;
    constructor(private readonly identity: string) {}
    async join(): Promise<void> {
      if (bridgeJoinFailures.has(this.identity)) {
        throw new Error(`${this.identity} could not join the room`);
      }
    }
    async disconnect(): Promise<void> { /* disconnected */ }
    async publishData(): Promise<void> { /* published */ }
  },
}));
vi.mock('../../../../db/usage/voiceCallUsageRepository.js', () => ({
  upsertVoiceCallUsage: vi.fn(async () => undefined),
}));
vi.mock('../../../../lib/plan-access.js', () => ({
  getUserEntitlements: vi.fn(async () => ({ features: { 'voice-cohost': true }, allowedModelIds: [] })),
}));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../../db/index.js';
import { userCredits } from '../../../../db/schema/billing.js';
import { getOrCreateUserCredits } from '../../../../db/billing/userCreditsRepository.js';
import { voiceSessionManager } from '../voice-session-manager.js';

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
  vi.clearAllMocks();
  /**
   * Cleared HERE, not at the end of the test that set it.
   *
   * A failing assertion aborts the test body, so a reset written after it never
   * runs and the next test inherits a cohost whose `join` throws. Measured: a
   * mutation that broke the failure path turned the POSITIVE CONTROL red too,
   * which reads as a stronger kill than it is and hides which assertion did the
   * killing.
   */
  bridgeJoinFailures.clear();
});

/** Namespaced by pid — several `*.pgdb.test.ts` files share ONE database. */
const SUITE = `voicesess-${process.pid}`;
let seq = 0;

async function account(free: number, paid: number): Promise<string> {
  const id = `${SUITE}-${seq++}`;
  await getOrCreateUserCredits(db, id);
  await db.update(userCredits).set({ creditsFree: free, creditsPaid: paid }).where(eq(userCredits.id, id));
  return id;
}

async function balanceOf(id: string): Promise<{ free: number; paid: number }> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  if (!row) throw new Error(`no balance row for ${id}`);
  return { free: row.creditsFree, paid: row.creditsPaid };
}

/**
 * A socket the manager will treat as open enough to wire handlers onto.
 *
 * `readyState` defaults to CLOSED (3), which is what the sessions that only
 * care about credits want — nothing then tries to send on it. A caller that
 * needs the CLOSE path exercised asks for OPEN (1), because every teardown in
 * the manager is guarded by `readyState === WebSocket.OPEN` and a closed socket
 * would make "we closed it" and "we ignored it" the same observation.
 */
function fakeSocket(readyState = 3): { readyState: number; on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { readyState, on: vi.fn(), send: vi.fn(), close: vi.fn() };
}

const config = { model: 'alia-v1-voice', instructions: 'be brief', maxDuration: 30 };

describe('createSession — the minute it reserves up front', () => {
  it('keeps the reservation when the session comes up', async () => {
    const userId = await account(500, 0);
    connect.mockResolvedValueOnce(fakeSocket());

    const session = await voiceSessionManager.createSession(userId, 'alia-v1-voice', config);

    // The positive control: 100 credits held for a live call, settled when it
    // ends. An implementation that refunded unconditionally would pass every
    // case below and fail this one.
    expect(await balanceOf(userId)).toEqual({ free: 400, paid: 0 });
    await voiceSessionManager.closeSession(session.sessionId, 'test over');
  });

  it('gives the whole minute back when the PROVIDER refuses the connection', async () => {
    const userId = await account(500, 0);
    connect.mockRejectedValueOnce(new Error('provider refused the socket'));

    await expect(
      voiceSessionManager.createSession(userId, 'alia-v1-voice', config),
    ).rejects.toThrow('provider refused the socket');

    // Not 499. The call never happened, so not even the one-credit minimum
    // `finalizeVoiceCredits` would floor an 0.01-minute session at.
    expect(await balanceOf(userId)).toEqual({ free: 500, paid: 0 });
  });

  it('gives a paid-funded minute back to the PAID balance', async () => {
    const userId = await account(0, 500);
    connect.mockRejectedValueOnce(new Error('provider refused the socket'));

    await expect(
      voiceSessionManager.createSession(userId, 'alia-v1-voice', config),
    ).rejects.toThrow('provider refused the socket');

    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 500 });
  });

  it('debits nothing when the balance will not cover a minute', async () => {
    const userId = await account(10, 0);

    await expect(
      voiceSessionManager.createSession(userId, 'alia-v1-voice', config),
    ).rejects.toThrow('Insufficient credits');

    expect(await balanceOf(userId)).toEqual({ free: 10, paid: 0 });
  });
});

/**
 * The cohost reserves a SECOND minute, and `disableCohost` cannot give it back.
 *
 * `enableCohost` reserves a hundred more credits, then opens a second provider
 * socket, joins a second LiveKit participant, wires handlers and starts a timer
 * — and only at the very end sets `session.cohostEnabled = true`. Its `catch`
 * calls `disableCohost`, whose first line is `if (!session.cohostEnabled)
 * return`. So every failure during cohost setup — which is every failure that
 * can actually happen, since the flag is last — returned immediately and the
 * hundred credits stayed debited with nothing holding them.
 *
 * A cohost is a Pro feature enabled mid-call by the client, so this fires while
 * somebody is talking and the only symptom is a balance that dropped.
 */
describe('enableCohost — the second minute it reserves', () => {
  it('gives the minute back when the cohost provider refuses the connection', async () => {
    const userId = await account(500, 0);
    connect.mockResolvedValueOnce(fakeSocket());
    const session = await voiceSessionManager.createSession(userId, 'alia-v1-voice', config);
    expect(await balanceOf(userId)).toEqual({ free: 400, paid: 0 });

    connect.mockRejectedValueOnce(new Error('provider refused the cohost socket'));
    await voiceSessionManager.enableCohost(session.sessionId);

    // The primary's 100 are still held — it is still a live call. The cohost's
    // 100 came back.
    expect(await balanceOf(userId)).toEqual({ free: 400, paid: 0 });

    await voiceSessionManager.closeSession(session.sessionId, 'test over');
  });

  it('keeps the minute when the cohost comes up', async () => {
    const userId = await account(500, 0);
    connect.mockResolvedValueOnce(fakeSocket());
    const session = await voiceSessionManager.createSession(userId, 'alia-v1-voice', config);

    connect.mockResolvedValueOnce(fakeSocket());
    await voiceSessionManager.enableCohost(session.sessionId);

    // The positive control: two reservations held for two live participants.
    // A version that refunded the cohost unconditionally would pass the case
    // above and fail this one.
    expect(await balanceOf(userId)).toEqual({ free: 300, paid: 0 });

    await voiceSessionManager.closeSession(session.sessionId, 'test over');
  });
});

/**
 * The cohost's provider socket is CLOSED when its setup fails after opening it.
 *
 * `enableCohost` opens the provider socket, assigns it to the session, and only
 * then builds the LiveKit bridge and joins the room. `session.cohostEnabled` is
 * set at the very END. So a `join` failure lands in the `catch` with an open
 * socket on the session and the flag still false — and `disableCohost`, which
 * the catch used to delegate to, returns on its first line for exactly that
 * flag.
 *
 * `closeSession` would eventually close it, which bounds the leak to the rest of
 * the call. What is NOT bounded is a retry: the client can send `cohost.enable`
 * again, `enableCohost` only refuses when `cohostEnabled` is true, and the second
 * attempt overwrites `session.cohostProviderSocket` with a new socket. The first
 * one is then open with nothing referencing it, past the reach of the teardown
 * that would have closed it.
 */
describe('enableCohost — the resources it opened before failing', () => {
  it('closes the provider socket when the cohost cannot join the room', async () => {
    const userId = await account(500, 0);
    connect.mockResolvedValueOnce(fakeSocket());
    const session = await voiceSessionManager.createSession(userId, 'alia-v1-voice', config);

    // OPEN, so `close()` being called is distinguishable from being skipped.
    const cohostSocket = fakeSocket(1);
    connect.mockResolvedValueOnce(cohostSocket);
    bridgeJoinFailures.add('alia-cohost');

    await voiceSessionManager.enableCohost(session.sessionId);

    expect(cohostSocket.close).toHaveBeenCalled();
    // And nothing is left on the session for a retry to overwrite and orphan.
    expect(voiceSessionManager.getSession(session.sessionId)?.cohostProviderSocket).toBeNull();

    await voiceSessionManager.closeSession(session.sessionId, 'test over');
  });

  /**
   * The positive control. A cohost that comes up KEEPS its socket, so the case
   * above is measuring a failure path rather than an implementation that closes
   * the socket every time.
   */
  it('leaves the socket open when the cohost comes up', async () => {
    const userId = await account(500, 0);
    connect.mockResolvedValueOnce(fakeSocket());
    const session = await voiceSessionManager.createSession(userId, 'alia-v1-voice', config);

    const cohostSocket = fakeSocket(1);
    connect.mockResolvedValueOnce(cohostSocket);

    await voiceSessionManager.enableCohost(session.sessionId);

    expect(cohostSocket.close).not.toHaveBeenCalled();
    expect(voiceSessionManager.getSession(session.sessionId)?.cohostProviderSocket).not.toBeNull();

    await voiceSessionManager.closeSession(session.sessionId, 'test over');
  });
});
