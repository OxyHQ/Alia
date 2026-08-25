import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression fixtures for the voice flow — epic #139 workstream 13.
 *
 * Voice is the one modality with NO provider fallback
 * (`behaviour-voice-realtime` in `docs/migration/ownership-matrix.json`), so the
 * things a client can observe are the gates in front of the session and the
 * shape of the refusal when one of them says no. Those are pinned here in full.
 *
 * Transcription (`POST /v1/voice/transcribe`) DOES fail over, and its provider
 * hop goes through `lib/gateway-client.js` — the seam ADR 0001 names as the one
 * that survives the migration. That makes it drivable end to end at exactly the
 * boundary the epic moves, so it is pinned end to end.
 *
 * ## The gap, stated rather than papered over
 *
 * `POST /v1/voice/token` assembles the session instructions (base prompt, user
 * context, an optional full client override, then the identity guard prepended
 * LAST so it survives that override) and the six server-executed voice tools,
 * and hands both to `voiceSessionManager.createSession`. Reading what it handed
 * over needs a module mock of `internal/providers/lib/voice-session-manager.ts`,
 * and gate 1 of `src/__tests__/architectureGates.test.ts` freezes the set of
 * files that may name a module inside `internal/providers/` — a `vi.mock` counts
 * (it is how two existing test seams are recorded there). Adding an entry to
 * that frozen list to reach further into this route is a change to another
 * workstream's gate, so it is NOT done here.
 *
 * What that costs, precisely: the instruction ORDER (identity guard survives a
 * client override), the six tool names, and the `maxDuration` cap arithmetic are
 * unpinned. What is pinned instead is everything observable up to that call —
 * including that the context recall and the prompt load both happen BEFORE it,
 * which is the property an inference-path swap is most likely to disturb.
 */

const H = vi.hoisted(() => {
  const timeline: string[] = [];
  const state = {
    liveKitConfigured: true,
    entitlements: {
      tier: 'pro',
      features: {} as Record<string, unknown>,
      allowedModelIds: [] as string[],
    },
    voiceUsage: { usedMinutes: 0, limitMinutes: 60, remainingMinutes: 60 },
    /** `callProviderAPI` behaviour per attempt, consumed in order. */
    transcriptionAttempts: [] as Array<{ text: string } | Error>,
    audioMappings: [] as Array<{ provider: string; modelId: string }>,
    /** `none` = credits available, `insufficient` = reserve returns null, `store-down` = the store throws. */
    credits: 'none' as 'none' | 'insufficient' | 'store-down',
  };
  return { timeline, state };
});

/** Synthetic upstream identity: a real one must never reach a client. */
const UPSTREAM_A = 'zzprovider-a';
const UPSTREAM_B = 'zzprovider-b';

vi.mock('../../../lib/livekit-token.js', () => ({
  isLiveKitConfigured: vi.fn(() => H.state.liveKitConfigured),
  getLiveKitUrl: vi.fn(() => 'wss://livekit.test'),
  getLiveKitInternalUrl: vi.fn(() => 'wss://livekit.internal.test'),
  createVoiceToken: vi.fn(async () => 'voice-token'),
  createAgentToken: vi.fn(async () => 'agent-token'),
  createVoiceRoom: vi.fn(async () => undefined),
  deleteVoiceRoom: vi.fn(async () => undefined),
}));

vi.mock('../../../lib/livekit-agent.js', () => ({
  LiveKitAgentBridge: class {
    async connect() {
      return undefined;
    }
  },
}));

vi.mock('../../../lib/plan-access.js', () => ({
  getUserEntitlements: vi.fn(async () => {
    H.timeline.push('gate:entitlements');
    return H.state.entitlements;
  }),
}));

vi.mock('../../../lib/voice-usage.js', () => ({
  getVoiceUsageSummary: vi.fn(async () => {
    H.timeline.push('gate:voiceMinutes');
    return H.state.voiceUsage;
  }),
}));

vi.mock('../../../lib/user-context.js', () => ({
  buildUserContext: vi.fn(async () => {
    H.timeline.push('recall:userContext');
    return { contextString: '\n\nThe user is a systems engineer.', language: 'en-US' };
  }),
}));

vi.mock('../../../lib/gateway-client.js', () => ({
  getAliaModel: vi.fn(async (id: string) => ({ id, name: 'Alia Voice', tier: 'v1-voice', creditMultiplier: 1 })),
  getModelMappingsForTier: vi.fn(async () => {
    H.timeline.push('provider:tierMappings');
    return H.state.audioMappings;
  }),
  callProviderAPI: vi.fn(async () => {
    const attempt = H.state.transcriptionAttempts.shift();
    H.timeline.push('provider:transcribeAttempt');
    if (attempt instanceof Error) throw attempt;
    if (!attempt) throw new Error('no scripted attempt left');
    return attempt;
  }),
}));

vi.mock('../../../lib/credits-manager.js', () => ({
  reserveCredits: vi.fn(async () => {
    H.timeline.push('credits:reserve');
    return H.state.credits === 'insufficient' ? null : { userId: 'user-ws13', creditsReserved: 1, initialFreeCredits: 100, initialPaidCredits: 0 };
  }),
  finalizeCredits: vi.fn(async (_r: unknown, usage: { totalTokens?: number }) => {
    H.timeline.push(`credits:finalize(${usage?.totalTokens ?? 0})`);
    return { creditsCharged: 1, creditsRemaining: 99 };
  }),
  refundReservation: vi.fn(async () => undefined),
  safeRefund: vi.fn(async () => {
    H.timeline.push('credits:refund');
  }),
  reserveVoiceCredits: vi.fn(async () => ({ userId: 'user-ws13', creditsReserved: 1 })),
  finalizeVoiceCredits: vi.fn(async () => undefined),
}));

vi.mock('../../../lib/user-credits-helpers.js', () => ({
  getOrCreateUserCredits: vi.fn(async () => {
    if (H.state.credits === 'store-down') throw new Error('whisper-1 credit store unreachable');
    return { creditsFree: 100, creditsPaid: 0 };
  }),
}));

vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, chat: child, general: child, providers: child, codea: child } };
});

import voiceRouter from '../voice.js';

// ── Router plumbing ────────────────────────────────────────────────────────

interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: unknown) => Promise<void> | void }>;
  };
}

type Handler = (req: unknown, res: unknown, next: unknown) => Promise<void> | void;

function handlerFor(path: string): Handler {
  const stack = (voiceRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((entry) => entry.route?.path === path && entry.route.methods?.post);
  if (!layer?.route) throw new Error(`POST ${path} not mounted on the voice router`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

interface CapturedRes {
  status(code: number): CapturedRes;
  json(body: unknown): void;
  statusCode: number | null;
  body: unknown;
}

function capturingRes(): CapturedRes {
  const res: CapturedRes = {
    statusCode: null,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      H.timeline.push(`http:status(${code})`);
      return res;
    },
    json(body: unknown) {
      res.body = body;
      H.timeline.push('http:json');
    },
  };
  return res;
}

const voiceReq = (body: Record<string, unknown>) => ({ user: { id: 'user-ws13' }, body });
const anonymousReq = (body: Record<string, unknown>) => ({ user: undefined, body });

beforeEach(() => {
  H.timeline.length = 0;
  H.state.liveKitConfigured = true;
  H.state.entitlements = { tier: 'pro', features: { 'voice-mode': true }, allowedModelIds: ['alia-v1-voice'] };
  H.state.voiceUsage = { usedMinutes: 0, limitMinutes: 60, remainingMinutes: 60 };
  H.state.transcriptionAttempts = [];
  H.state.audioMappings = [
    { provider: UPSTREAM_A, modelId: 'zz-transcribe-1' },
    { provider: UPSTREAM_B, modelId: 'zz-transcribe-2' },
  ];
  H.state.credits = 'none';
  vi.clearAllMocks();
});

// ===========================================================================
// Fixture — POST /v1/voice/token, the gates in front of a voice session
// ===========================================================================

describe('fixture: voice session token — the refusal sequence', () => {
  const token = () => handlerFor('/token');

  it('refuses an unauthenticated caller before consulting anything', async () => {
    const res = capturingRes();
    await token()(anonymousReq({}), res, undefined);

    expect(H.timeline).toEqual(['http:status(401)', 'http:json']);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('refuses when voice is not deployed, before the entitlement lookup', async () => {
    H.state.liveKitConfigured = false;
    const res = capturingRes();
    await token()(voiceReq({}), res, undefined);

    // Order matters here in a way a per-assertion check would miss: the
    // infrastructure gate runs BEFORE any plan lookup, so a deployment without
    // voice cannot bill or refuse on plan grounds.
    expect(H.timeline).toEqual(['http:status(503)', 'http:json']);
    expect(res.body).toEqual({ error: 'Voice mode is not available. LiveKit is not configured.' });
  });

  it('refuses a plan without the voice feature', async () => {
    H.state.entitlements = { tier: 'free', features: {}, allowedModelIds: ['alia-v1-voice'] };
    const res = capturingRes();
    await token()(voiceReq({}), res, undefined);

    expect(H.timeline).toEqual(['gate:entitlements', 'http:status(403)', 'http:json']);
    expect(res.body).toEqual({
      error: {
        code: 'FEATURE_NOT_IN_PLAN',
        message: 'Upgrade your plan to use voice mode.',
        retryable: false,
        suggestedAction: 'upgrade',
      },
    });
  });

  it('refuses when the monthly voice minutes are spent, and says by how much', async () => {
    H.state.entitlements = { tier: 'pro', features: { 'voice-mode': true, 'voice-minutes': 60 }, allowedModelIds: ['alia-v1-voice'] };
    H.state.voiceUsage = { usedMinutes: 60, limitMinutes: 60, remainingMinutes: 0 };
    const res = capturingRes();
    await token()(voiceReq({}), res, undefined);

    expect(H.timeline).toEqual(['gate:entitlements', 'gate:voiceMinutes', 'http:status(403)', 'http:json']);
    expect(res.body).toEqual({
      error: {
        code: 'VOICE_MINUTES_EXHAUSTED',
        message: "You've used all 60 voice minutes this month. Upgrade your plan for more.",
        retryable: false,
        suggestedAction: 'upgrade',
        details: { limitType: 'voice-minutes', usedMinutes: 60, limitMinutes: 60 },
      },
    });
  });

  it('checks the minutes budget BEFORE model access, not after', async () => {
    // Both gates return 403, so a client cannot tell them apart from the status
    // alone — only from the code. Recording the order matters because it decides
    // WHICH code a user on a spent budget asking for an unavailable model sees,
    // and the app routes the two to different upsell copy.
    H.state.entitlements = { tier: 'pro', features: { 'voice-mode': true, 'voice-minutes': 60 }, allowedModelIds: [] };
    H.state.voiceUsage = { usedMinutes: 60, limitMinutes: 60, remainingMinutes: 0 };
    const res = capturingRes();
    await token()(voiceReq({ model: 'alia-v1-voice-pro' }), res, undefined);

    expect((res.body as { error: { code: string } }).error.code).toBe('VOICE_MINUTES_EXHAUSTED');

    // The control: with budget left, the same request falls through to the
    // model gate. Without this, "minutes first" would also be what a route that
    // never reached the model gate at all reports.
    H.timeline.length = 0;
    H.state.voiceUsage = { usedMinutes: 0, limitMinutes: 60, remainingMinutes: 60 };
    const second = capturingRes();
    await token()(voiceReq({ model: 'alia-v1-voice-pro' }), second, undefined);
    expect(H.timeline).toEqual(['gate:entitlements', 'gate:voiceMinutes', 'http:status(403)', 'http:json']);
    expect(second.body).toEqual({
      error: {
        code: 'MODEL_NOT_IN_PLAN',
        message: 'Upgrade your plan to use this model.',
        retryable: false,
        suggestedAction: 'upgrade',
      },
    });
  });

  it('recalls the user context before it reaches the session manager', async () => {
    // `alia-v1-voice` is the default when the client sends no model
    // (`routes/v1/voice.ts:78`), so this also pins that default.
    const res = capturingRes();
    await token()(voiceReq({}), res, undefined);

    // Every gate passed, so the route ran on into prompt assembly. The context
    // recall is on the pre-session side of the sequence: an inference-path swap
    // that moved it after the session opens would change what the first spoken
    // turn knows about the user.
    expect(H.timeline.slice(0, 2)).toEqual(['gate:entitlements', 'recall:userContext']);

    // What happens next is the gap this file opens with: creating the session
    // reaches into the provider tree, which this suite deliberately does not
    // stand up, so the call throws. That is not wasted — it exercises the one
    // failure surface the route has, and every voice failure lands on it:
    // a coded, `retryable: false` envelope carrying a message that has been
    // through `sanitizeMessage`, never the raw internal reason.
    const error = (res.body as { error: { code: string; retryable: boolean; message: string } }).error;
    expect(['INSUFFICIENT_CREDITS', 'RATE_LIMIT_EXCEEDED', 'INVALID_MODEL', 'INTERNAL_ERROR']).toContain(error.code);
    expect(error.retryable).toBe(false);
    expect(typeof error.message).toBe('string');
    expect(error.message.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Fixture — POST /v1/voice/transcribe, end to end at the gateway seam
// ===========================================================================

describe('fixture: voice transcription — failover, credits, and the timeout surface', () => {
  const transcribe = () => handlerFor('/transcribe');
  const audioBody = { audio: 'YXVkaW8=', format: 'audio/m4a' };

  it('emits one exact ordered transcript on the happy path', async () => {
    H.state.transcriptionAttempts = [{ text: 'hello there' }];
    const res = capturingRes();
    await transcribe()(voiceReq(audioBody), res, undefined);

    expect(H.timeline).toEqual([
      // Credits are reserved BEFORE the provider is called, so a caller with no
      // balance never reaches an upstream.
      'credits:reserve',
      'provider:tierMappings',
      'provider:transcribeAttempt',
      // 50 prompt + 50 completion: transcription bills a flat estimate
      // (`routes/v1/voice.ts:351-355`), not a measured token count.
      'credits:finalize(100)',
      'http:json',
    ]);
    expect(res.statusCode).toBeNull();
    expect(res.body).toEqual({ text: 'hello there' });
  });

  it('fails over to the next provider in tier order and still bills once', async () => {
    H.state.transcriptionAttempts = [new Error('zzprovider-a refused'), { text: 'second try' }];
    const res = capturingRes();
    await transcribe()(voiceReq(audioBody), res, undefined);

    expect(H.timeline).toEqual([
      'credits:reserve',
      'provider:tierMappings',
      'provider:transcribeAttempt',
      'provider:transcribeAttempt',
      'credits:finalize(100)',
      'http:json',
    ]);
    expect(res.body).toEqual({ text: 'second try' });

    // The attempts went out in the order the tier lists them, and the failed
    // provider is not named to the client.
    const { callProviderAPI } = await import('../../../lib/gateway-client.js');
    const providers = vi.mocked(callProviderAPI).mock.calls.map((call) => (call[0] as { provider: string }).provider);
    expect(providers).toEqual([UPSTREAM_A, UPSTREAM_B]);
    expect(JSON.stringify(res.body)).not.toContain(UPSTREAM_A);
  });

  /**
   * REFUNDED, and it used to be settled at zero.
   *
   * The previous version of this case asserted `credits:finalize(0)` and said
   * in a comment that a failed transcription "costs nothing but the reservation
   * must not be left open". The first half was wrong:
   * `calculateCreditsFromTokens` returns `MIN_CREDITS_PER_REQUEST` for zero
   * tokens, so settling at zero CHARGES one credit — the whole reservation —
   * for an audio clip nobody ever got back as text.
   *
   * The reservation is still not left open. It is released by the route's
   * `finally`, which is why `credits:refund` appears after the 503 rather than
   * before it.
   */
  it('returns 503 when every provider in the tier fails, and refunds the reservation', async () => {
    H.state.transcriptionAttempts = [new Error('down'), new Error('down')];
    const res = capturingRes();
    await transcribe()(voiceReq(audioBody), res, undefined);

    expect(H.timeline).toEqual([
      'credits:reserve',
      'provider:tierMappings',
      'provider:transcribeAttempt',
      'provider:transcribeAttempt',
      'http:status(503)',
      'http:json',
      'credits:refund',
    ]);
    expect(res.body).toEqual({ error: 'All transcription providers exhausted' });
  });

  it('refuses with 402 before touching a provider when credits are gone', async () => {
    H.state.credits = 'insufficient';
    const res = capturingRes();
    await transcribe()(voiceReq(audioBody), res, undefined);

    expect(H.timeline).toEqual(['credits:reserve', 'http:status(402)', 'http:json']);
    expect(res.body).toEqual({
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: "You've run out of credits. Add more or upgrade your plan to continue.",
        retryable: false,
        suggestedAction: 'upgrade',
        details: { limitType: 'credits' },
      },
    });
  });

  it('rejects a request with no audio, before reserving anything', async () => {
    const res = capturingRes();
    await transcribe()(voiceReq({ format: 'audio/m4a' }), res, undefined);

    expect(H.timeline).toEqual(['http:status(400)', 'http:json']);
    expect(res.body).toEqual({ error: 'Audio data is required (base64 encoded)' });
  });

  it('conceals the upstream model id in an error before the user sees it', async () => {
    // Reachable in production: the credit store is a network dependency, and its
    // failure escapes to the route's own catch (`routes/v1/voice.ts:361`), which
    // is the only path on this route that renders a raw upstream message.
    //
    // The probe carries `whisper-1`, the transcription model id a real failure on
    // this path names. It used to carry the bare word "whisper": #139 workstream
    // 20 scoped concealment to identifiers and proper nouns, so an ordinary
    // lowercase word is deliberately left alone now and the probe would no longer
    // be testing anything. The property under test is unchanged — this route
    // renders through the sanitiser, never the raw internal reason.
    H.state.credits = 'store-down';
    const res = capturingRes();
    await transcribe()(voiceReq(audioBody), res, undefined);

    expect(res.statusCode).toBe(500);
    const body = res.body as { error: string };
    // Positive control on the scan: the rest of the message DID survive, so the
    // absence below is redaction rather than an empty string.
    expect(body.error).toBe('[model] credit store unreachable');
    expect(body.error).not.toContain('whisper');
  });
});
