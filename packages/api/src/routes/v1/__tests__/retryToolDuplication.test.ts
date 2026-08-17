import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The live fallback loop does not re-run a tool it has already run —
 * epic #139 workstream 13, "Ensure retries/fallbacks do not duplicate tools or
 * agent side effects".
 *
 * ## Why this exists beside the Relay client's own retry tests
 *
 * `lib/inference/__tests__/relay-client.test.ts` guards the SAME property for
 * the Relay client (`mayRetry`'s `yielded === 0` conjunct). That client is not
 * the live path: `isRelayClientEnabled` is off by default and nothing in
 * `packages/api` imports it, which `relay-boundary.test.ts` freezes. The path
 * that retries in production today is `runProviderLoop`, and until this file
 * nothing measured whether IT could duplicate a tool effect.
 *
 * ## Where the property actually lives, measured
 *
 * `runStream` re-throws an upstream error — which is what makes
 * `runProviderLoop` try the next provider — only when nothing has been streamed
 * (`lib/chat/stream-runner.ts:309`). The flag that answers "has anything been
 * streamed" is set by the TOOL-CALL chunk and by the TOOL-RESULT chunk
 * (`:187`, `:221`), not only by text. That is the whole guard: once a tool has
 * been invoked, the request stops being retryable.
 *
 * It is also a guard whose NAME invites its own removal. `hasStreamedContent`
 * reads as "the user has seen some of the answer", and a tool call is not that;
 * deleting those two assignments looks like a tidy-up and produces a loop that
 * re-runs `sendEmail` on every provider in the tier. Nothing else in the suite
 * notices, which is why the assertion below is on the EXECUTION COUNT of a tool
 * rather than on the flag.
 *
 * The model seam is the same one `chatFlowFixtures.test.ts` uses — a fake
 * `LanguageModelV3` behind `chat-core.getAIModel` — so the AI SDK's agentic loop
 * is real and the tool genuinely executes.
 */

const H = vi.hoisted(() => {
  const state = {
    /**
     * `tool_then_error`: every turn OFFERED tools calls one and then fails.
     * `error_then_text`: the first turn fails with nothing streamed, later turns
     * answer — the control that proves a retry is observable at all.
     */
    mode: 'tool_then_error' as 'tool_then_error' | 'error_then_text',
    modelCalls: 0,
    /** Model calls that were OFFERED tools; the script alternates on this. */
    toolOfferedCalls: 0,
    toolRuns: 0,
    resolveCalls: 0,
  };
  /** `Model.findById(...).select(...).lean()` and `Model.findOne(...).lean()`, both null. */
  const emptyQuery = () => ({ select: () => ({ lean: async () => null }), lean: async () => null });
  return { state, emptyQuery };
});

const UPSTREAM_PROVIDER = 'zzprovider';
const UPSTREAM_MODEL_ID = 'zzprovider-frontier-9';

const V3_USAGE = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const RESOLVED = {
  aliasModelId: 'alia-v1',
  provider: UPSTREAM_PROVIDER,
  modelId: UPSTREAM_MODEL_ID,
  keyConfig: { provider: UPSTREAM_PROVIDER, key: 'secret', modelId: UPSTREAM_MODEL_ID, keyId: 'key-ws13' },
  aliaModel: { name: 'Alia V1', creditMultiplier: 1 },
  isFallback: false,
  fallbackIndex: 0,
};

vi.mock('../../../lib/chat-core.js', () => ({
  resolveModel: vi.fn(async () => {
    H.state.resolveCalls += 1;
    return RESOLVED;
  }),
  getAIModel: vi.fn(() => ({
    specificationVersion: 'v3',
    provider: UPSTREAM_PROVIDER,
    modelId: UPSTREAM_MODEL_ID,
    supportedUrls: {},
    doGenerate: async () => ({ content: [], finishReason: 'stop', usage: V3_USAGE, warnings: [] }),
    doStream: async (options: { tools?: Array<{ name: string }> }) => {
      H.state.modelCalls += 1;
      const offeredTools = (options.tools ?? []).length > 0;
      return { stream: scriptFor(offeredTools) };
    },
  })),
  reportModelUsage: vi.fn(async () => undefined),
  getDefaultAliaModel: vi.fn(() => 'alia-v1'),
}));

/**
 * What the fake upstream sends.
 *
 * The script keys on whether TOOLS WERE OFFERED and on how many tool-offering
 * calls have happened, not on a plain call counter, because the two runs being
 * compared make different numbers of calls: the mutant retries and the healthy
 * loop does not, so a plain counter would feed them different content and the
 * comparison would be about the script.
 *
 * Alternating on tool-offering calls: the first asks for a tool, the second
 * fails. So each PROVIDER ATTEMPT costs exactly one tool execution, and the
 * measurement "how many times did the tool run" IS "how many attempts happened".
 * A call offered NO tools is the runner's own tool-free synthesis retry
 * (`stream-runner.ts:333`), and it answers — so a loop that does not retry
 * finishes with one tool run and a real reply.
 */
function scriptFor(offeredTools: boolean): ReadableStream<Record<string, unknown>> {
  const start: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: [] }];
  const text: Array<Record<string, unknown>> = [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Recovered.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage: V3_USAGE, finishReason: 'stop' },
  ];
  const callTool: Array<Record<string, unknown>> = [
    { type: 'tool-input-start', id: 'call-1', toolName: 'webSearch' },
    { type: 'tool-input-end', id: 'call-1' },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'webSearch', input: '{"query":"alia"}' },
    { type: 'finish', usage: V3_USAGE, finishReason: 'tool-calls' },
  ];
  const failure: Array<Record<string, unknown>> = [
    { type: 'error', error: new Error('upstream exploded') },
  ];

  let parts: Array<Record<string, unknown>>;
  if (H.state.mode === 'error_then_text') {
    parts = H.state.modelCalls === 1 ? failure : text;
  } else if (!offeredTools) {
    parts = text;
  } else {
    H.state.toolOfferedCalls += 1;
    parts = H.state.toolOfferedCalls % 2 === 1 ? callTool : failure;
  }

  return new ReadableStream({
    start(controller) {
      for (const part of [...start, ...parts]) controller.enqueue(part);
      controller.close();
    },
  });
}

/** The one tool the model calls, counted at its own executor. */
vi.mock('../../../lib/tools/web-search.js', () => ({
  webSearchTool: {
    description: 'search the web',
    execute: vi.fn(async () => {
      H.state.toolRuns += 1;
      return { results: [{ url: 'https://example.test/a', title: 'A', snippet: 'first' }] };
    }),
  },
}));

vi.mock('../../../lib/gateway-client.js', () => ({
  getAliaModel: vi.fn(async (id: string) => ({ id, name: 'Alia V1', tier: 'v1', creditMultiplier: 1 })),
  getModelMappingsForTier: vi.fn(async () => [
    { provider: UPSTREAM_PROVIDER, modelId: UPSTREAM_MODEL_ID, capabilities: { maxContextTokens: 128000 } },
  ]),
}));
vi.mock('../../../lib/credits-manager.js', () => ({
  reserveCredits: vi.fn(async () => ({ userId: 'user-ws13', creditsReserved: 1, initialFreeCredits: 100, initialPaidCredits: 0 })),
  finalizeCredits: vi.fn(async () => ({ creditsCharged: 3, creditsRemaining: 97 })),
  refundReservation: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/user-credits-helpers.js', () => ({
  getOrCreateUserCredits: vi.fn(async () => ({ creditsFree: 100, creditsPaid: 0 })),
}));
vi.mock('../../../lib/plan-access.js', () => ({
  getUserEntitlements: vi.fn(async () => null),
}));
vi.mock('../../../lib/hooks/index.js', () => ({
  runBeforeChatHooks: vi.fn(async () => ({})),
  runAfterChatHooks: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/autonomy/runtime.js', () => ({
  runAutonomyBeforeChat: vi.fn(async () => null),
  runAutonomyAfterChat: vi.fn(async () => undefined),
  buildAutonomyPromptFragment: vi.fn(() => ''),
}));
vi.mock('../../../lib/conversation-saver.js', () => ({
  saveConversation: vi.fn(async () => undefined),
  generateTitle: vi.fn(async () => null),
  generateConversationTitle: vi.fn(async () => null),
}));
vi.mock('../../../lib/notification-service.js', () => ({ sendNotification: vi.fn(async () => undefined) }));
vi.mock('../../../lib/credit-anomaly.js', () => ({ detectCreditAnomaly: vi.fn(async () => null) }));
vi.mock('../../../middleware/api-key-rate-limit.js', () => ({
  recordUsage: vi.fn(async () => undefined),
  apiKeyRateLimit: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
}));
vi.mock('../../../middleware/auth.js', () => ({
  oxyClient: { getUserById: vi.fn(async () => null) },
  optionalAuth: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
  authenticateToken: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
  authenticateTokenOrApiKey: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
}));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../db/memory/userMemoryRepository.js', () => ({ findUserMemory: vi.fn(async () => null) }));
vi.mock('../../../models/conversation.js', () => ({
  Conversation: { findById: vi.fn(H.emptyQuery), findOne: vi.fn(H.emptyQuery), updateOne: vi.fn(async () => ({})) },
}));
vi.mock('../../../models/skill.js', () => ({ Skill: { findOne: vi.fn(H.emptyQuery) } }));
vi.mock('../../../models/agent.js', () => ({ Agent: { findById: vi.fn(H.emptyQuery) } }));
vi.mock('../../../lib/tools/mcp.js', () => ({ buildMcpTools: vi.fn(async () => ({})) }));
vi.mock('../../../lib/tools/integrations.js', () => ({ buildIntegrationTools: vi.fn(async () => ({})) }));
vi.mock('../../../lib/tools/oxy-services.js', () => ({
  buildOxyServiceTools: vi.fn(async () => ({})),
  getOxyServicePromptFragment: vi.fn(async () => ''),
  getOxyServiceContext: vi.fn(async () => ''),
}));
vi.mock('../../../lib/observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, chat: child, general: child, providers: child, codea: child, correlation: child } };
});

import { handleChatCompletions } from '../chat-completions.js';

// ── Request/response doubles ───────────────────────────────────────────────

/**
 * @param failOn a substring whose frame the socket refuses, once. Modelling a
 *   client that went away mid-response: `res.write` on a destroyed socket
 *   throws, and that exception escapes `runStream` rather than arriving as a
 *   stream chunk — which is the only way to reach the provider loop's OWN
 *   post-content guard (`provider-loop.ts:367`).
 */
function recordingRes(failOn?: string) {
  const raw: string[] = [];
  let failed = false;
  const res = {
    raw,
    headersSent: false,
    writableEnded: false,
    socket: { setNoDelay: () => undefined },
    setHeader: () => undefined,
    write(chunk: string) {
      if (failOn !== undefined && !failed && chunk.includes(failOn)) {
        failed = true;
        throw new Error('write after end');
      }
      raw.push(chunk);
      res.headersSent = true;
      return true;
    },
    end() {
      res.writableEnded = true;
    },
    flushHeaders() {
      res.headersSent = true;
    },
    status() {
      return res;
    },
    json() {
      res.headersSent = true;
    },
  };
  return res;
}

function apiKeyReq() {
  return {
    user: { id: 'user-ws13' },
    apiKey: { id: 'key-ws13' },
    headers: {},
    socket: { destroyed: false },
    on: () => undefined,
    off: () => undefined,
    body: {
      messages: [{ role: 'user', content: 'search the web for alia' }],
      model: 'alia-v1',
      stream: true,
    } as Record<string, unknown>,
  };
}

type RouteReq = Parameters<typeof handleChatCompletions>[0];
type RouteRes = Parameters<typeof handleChatCompletions>[1];

async function run(options: { failWriteOn?: string; includeUsage?: boolean } = {}): Promise<ReturnType<typeof recordingRes>> {
  const req = apiKeyReq();
  if (options.includeUsage === true) req.body.stream_options = { include_usage: true };
  const res = recordingRes(options.failWriteOn);
  await handleChatCompletions(req as unknown as RouteReq, res as unknown as RouteRes);
  return res;
}

beforeEach(() => {
  H.state.mode = 'tool_then_error';
  H.state.modelCalls = 0;
  H.state.toolOfferedCalls = 0;
  H.state.toolRuns = 0;
  H.state.resolveCalls = 0;
  vi.clearAllMocks();
});

// ===========================================================================

describe('a provider failure after a tool ran is not retried on another provider', () => {
  it('runs the tool exactly once, however many providers remain', async () => {
    const res = await run();

    // THE assertion. The retry budget is `max(tierMappings, 5)` attempts
    // (`provider-loop.ts:127`), and every one of them would have called the tool
    // again, so "once" here is a statement about the guard rather than about a
    // loop that had nowhere to go.
    expect(H.state.toolRuns).toBe(1);

    // The corroborating shape: no re-resolve happened. `resolveModel` is called
    // once by the pre-flight and once per RETRY (`provider-loop.ts:147`), so a
    // count of one is "no second attempt was started".
    expect(H.state.resolveCalls).toBe(1);

    // ...and the user was still answered, from the tool-free synthesis retry,
    // so this is not a request that simply died before it could retry.
    const bytes = res.raw.join('');
    expect(bytes).toContain('Recovered.');
    expect(bytes).toContain('data: [DONE]');
    expect(res.writableEnded).toBe(true);

    // The tool call and its result reached the client exactly once each, which
    // is what a client counting side effects would see.
    expect(res.raw.filter((frame) => frame.includes('"tool_calls"'))).toHaveLength(1);
    expect(res.raw.filter((frame) => frame.startsWith('event: alia.tool_result'))).toHaveLength(1);

    // No provider identity in the bytes, on this path as on every other.
    // Positive control on the scan: the alias IS there.
    expect(bytes).toContain('alia-v1');
    expect(bytes).not.toContain(UPSTREAM_PROVIDER);
  });

  it('does not retry when the FAILURE ITSELF is the client going away', async () => {
    /**
     * The second layer, and the one the assertion above cannot reach: when the
     * exception escapes `runStream` instead of arriving as a stream chunk, it is
     * `provider-loop.ts:367` that refuses the retry.
     *
     * The trigger is the usage chunk, because it is the first thing written
     * AFTER the tool has run and the answer is complete, and writing to a
     * destroyed socket is the ordinary way a request dies at that point.
     */
    const res = await run({ includeUsage: true, failWriteOn: 'alia_usage' });

    expect(H.state.toolRuns).toBe(1);
    expect(H.state.resolveCalls).toBe(1);
    // The route's own mid-stream recovery took over, so the request ended
    // rather than being abandoned — a floor proving the run got that far.
    expect(res.raw.join('')).toContain('data: [DONE]');
  });

  it('DOES retry when the failure produced nothing (the control)', async () => {
    // Without this, "the tool ran once" above is also what a harness that cannot
    // observe a retry at all would report — and the whole file would be vacuous.
    H.state.mode = 'error_then_text';
    const res = await run();

    expect(H.state.resolveCalls).toBe(2);
    expect(H.state.modelCalls).toBe(2);
    expect(H.state.toolRuns).toBe(0);
    expect(res.raw.join('')).toContain('Recovered.');
  });
});
