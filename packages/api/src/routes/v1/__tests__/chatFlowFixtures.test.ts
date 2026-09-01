import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression fixtures for the four product flows that reach POST
 * /v1/chat/completions — epic #139 workstream 13.
 *
 * ## The one question these exist to answer
 *
 * Every other workstream in the epic eventually rewires the inference call.
 * These fixtures record what the product emits TODAY so that "did the swap
 * change product behaviour?" is a diff rather than a user report months later.
 *
 * ## Where the seam is, and why it is there and not higher up
 *
 * The model call is mocked at the LANGUAGE MODEL, not at `streamText`. A fake
 * `LanguageModelV3` is handed back by `chat-core.getAIModel`, which is the one
 * function the product calls to turn a resolved provider key into a callable
 * model (`lib/chat/model-config.ts:54`). Everything above it runs for real: the
 * route, `buildChatRequestContext`, `ToolPipeline`, `SystemPromptBuilder`,
 * `convertToAISDKMessages`, `runProviderLoop`, `runStream`, `SSEWriter`, the
 * OpenAI chunk helpers, `chat-lifecycle`, the real error classifier and the real
 * AI SDK — including its agentic loop, so TOOLS ACTUALLY EXECUTE.
 *
 * That last point is why the seam is not `streamText`. Mocking `streamText`
 * means yielding `tool-call` and `tool-result` chunks by hand, which makes the
 * fixture assert its own script: the question "where does tool execution sit in
 * the sequence?" cannot be answered by a fixture that fabricates both sides of
 * it. With the model-level seam the SDK receives a tool call, runs the real
 * tool, and the result frame is a consequence rather than an input.
 *
 * `resolveModel` IS mocked, because it is the provider-key/rate-limit/circuit
 * -breaker boundary — precisely the thing ADR 0001 moves — and it is the only
 * remaining reason this suite would need a database.
 *
 * ## What is asserted, and why it is a TRANSCRIPT
 *
 * Each fixture asserts one ordered transcript by exact equality. The transcript
 * interleaves what the client sees (every SSE frame, classified by kind) with
 * the side effects the flow performs (recall, model call, persistence, credit
 * finalization, notification). Exact equality in both directions is deliberate:
 * a dropped event, an inserted event and a reordered event all fail, and so does
 * moving recall to after the model call — which no per-assertion check on the
 * frames alone would notice.
 *
 * The transcript labels are derived from the bytes, never from the source: a
 * frame is classified by parsing what was written, so a frame whose payload
 * changes shape reclassifies and the equality fails.
 *
 * ## What each assertion would report if the thing it measures were absent
 *
 * Stated per fixture at the assertion. The general shape: an empty transcript is
 * what a handler that returned immediately produces AND what a broken recorder
 * produces, so every transcript equality is paired with a non-empty floor and
 * the recorder itself is pinned by `classifyFrame`'s own unit tests below.
 */

// ── Recorder + provider script, shared with the mock factories ──────────────

const H = vi.hoisted(() => {
  const timeline: string[] = [];

  /**
   * Every `AfterChatContext` the route handed the hook chain, so the OBSERVABLE
   * fields of a turn can be asserted at the route rather than only at the hook.
   */
  const afterChat: Array<Record<string, unknown>> = [];

  interface ScriptedPart {
    type: string;
    [key: string]: unknown;
  }

  const state = {
    /** One entry consumed per `doStream` call; the last entry repeats. */
    streamTurns: [] as ScriptedPart[][],
    /** Content array returned by `doGenerate` (non-streaming path). */
    generateContent: [] as Array<{ type: string; [key: string]: unknown }>,
    generateFinishReason: 'stop',
    /** `resolveModel` answers, consumed in order; the last answer repeats. */
    resolveAnswers: [] as unknown[],
    reservation: null as unknown,
    entitlements: null as unknown,
    recalledMemories: undefined as unknown,
    userMemory: null as unknown,
    searchResults: [] as Array<{ url: string; title: string; snippet: string }>,
    /**
     * Every request the fake model received, in call order. Reading the ASSEMBLED
     * request is what turns "recall ran first" into "recall reached the model".
     */
    calls: [] as Array<{ prompt?: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> }>,
    /**
     * Fired at the top of every model call. The only way to reach a mid-stream
     * event (a client disconnect) at a point where the route has actually
     * subscribed to it — the listener is registered inside the provider loop,
     * several awaits after the handler is entered.
     */
    onModelCall: null as ((callIndex: number) => void) | null,
  };

  /** `Model.findById(...).select(...).lean()` and `Model.findOne(...).lean()`, both resolving to null. */
  const emptyQuery = () => ({ select: () => ({ lean: async () => null }), lean: async () => null });

  /**
   * Upstream identity, deliberately synthetic rather than a real provider name.
   *
   * Two reasons. It keeps a provider name out of this file, which the frozen
   * hostname/alias censuses in `src/__tests__/architectureGates.test.ts` scan;
   * and it makes the leak check below a control that would actually fire — a
   * string this unusual appears in the response bytes only if the code put it
   * there.
   */
  const UPSTREAM_PROVIDER = 'zzprovider';
  const UPSTREAM_MODEL_ID = 'zzprovider-frontier-9';

  const V3_USAGE = {
    inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };

  return { timeline, afterChat, state, emptyQuery, UPSTREAM_PROVIDER, UPSTREAM_MODEL_ID, V3_USAGE };
});

const { UPSTREAM_PROVIDER, UPSTREAM_MODEL_ID, V3_USAGE } = H;

// ── Module mocks: the provider boundary and the stores, nothing else ────────

vi.mock('../../../lib/chat-core.js', () => ({
  resolveModel: vi.fn(async () => {
    const answers = H.state.resolveAnswers;
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    return answer ?? null;
  }),
  getAIModel: vi.fn(() => ({
    specificationVersion: 'v3',
    provider: H.UPSTREAM_PROVIDER,
    modelId: H.UPSTREAM_MODEL_ID,
    supportedUrls: {},
    doGenerate: async (options: { prompt?: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> }) => {
      H.timeline.push('model:doGenerate');
      H.state.calls.push(options);
      return {
        content: H.state.generateContent,
        finishReason: H.state.generateFinishReason,
        usage: H.V3_USAGE,
        warnings: [],
      };
    },
    doStream: async (options: { prompt?: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> }) => {
      H.timeline.push('model:doStream');
      H.state.calls.push(options);
      H.state.onModelCall?.(H.state.calls.length);
      const turns = H.state.streamTurns;
      const parts = turns.length > 1 ? turns.shift() : turns[0];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts ?? []) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  })),
  reportModelUsage: vi.fn(async (_keyId: unknown, _provider: unknown, _modelId: unknown, success: boolean) => {
    H.timeline.push(`provider:reportUsage:${success ? 'ok' : 'fail'}`);
  }),
  getDefaultRoutingProfile: vi.fn(() => 'kaana-v1'),
}));

/**
 * Whether the person has a device offering the local model this fixture names.
 *
 * Hoisted so the module factory below can read it, and flipped per test: the
 * two states are the whole point of the pair of fixtures at the bottom of this
 * file — connected must reach the model, disconnected must reach nothing.
 */
const LOCAL = vi.hoisted(() => ({ connected: true }));

/**
 * Only PRESENCE is faked. Presence is a live socket lookup and there are no
 * sockets here; the id format and its parser stay real, because "does the route
 * agree with the bridge about what `local/<runtime>/<model>` means" is exactly
 * what these fixtures are for. Faking the parse too would leave them asserting
 * their own spelling.
 */
vi.mock('../../../lib/inference/user-runtime-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/inference/user-runtime-bridge.js')>(
    '../../../lib/inference/user-runtime-bridge.js',
  );
  return { ...actual, userRuntimeCanServe: vi.fn(async () => LOCAL.connected) };
});

vi.mock('../../../lib/gateway-client.js', () => ({
  getRoutingProfile: vi.fn(async (id: string) => ({ id, name: 'Kaana V1', tier: 'v1', creditMultiplier: 1 })),
  getModelMappingsForTier: vi.fn(async () => [{ provider: H.UPSTREAM_PROVIDER, modelId: H.UPSTREAM_MODEL_ID, capabilities: { maxContextTokens: 128000 } }]),
}));

vi.mock('../../../lib/credits-manager.js', () => ({
  reserveCredits: vi.fn(async () => {
    H.timeline.push('credits:reserve');
    return H.state.reservation;
  }),
  finalizeCredits: vi.fn(async () => {
    H.timeline.push('credits:finalize');
    return { creditsCharged: 3, creditsRemaining: 97 };
  }),
  refundReservation: vi.fn(async () => {
    H.timeline.push('credits:refund');
  }),
  // Mirrors the real helper: it refunds through `refundReservation`, so the
  // timeline records a refund taken by either name.
  safeRefund: vi.fn(async (reservation: unknown) => {
    if (reservation) H.timeline.push('credits:refund');
  }),
}));

vi.mock('../../../lib/user-credits-helpers.js', () => ({
  getOrCreateUserCredits: vi.fn(async () => ({ creditsFree: 100, creditsPaid: 0 })),
}));

vi.mock('../../../lib/plan-access.js', () => ({
  getUserEntitlements: vi.fn(async () => H.state.entitlements),
}));

vi.mock('../../../lib/hooks/index.js', () => ({
  runBeforeChatHooks: vi.fn(async () => {
    H.timeline.push('recall:beforeChatHooks');
    return { metadata: { recalledMemories: H.state.recalledMemories } };
  }),
  runAfterChatHooks: vi.fn(async (ctx: Record<string, unknown>) => {
    H.afterChat.push(ctx);
    H.timeline.push('hooks:afterChat');
  }),
}));

vi.mock('../../../lib/autonomy/runtime.js', () => ({
  runAutonomyBeforeChat: vi.fn(async () => null),
  runAutonomyAfterChat: vi.fn(async () => undefined),
  buildAutonomyPromptFragment: vi.fn(() => ''),
}));

vi.mock('../../../lib/conversation-saver.js', () => ({
  saveConversation: vi.fn(async (params: { assistantResponse?: string }) => {
    H.timeline.push(`persist:conversation(${JSON.stringify(params.assistantResponse ?? '')})`);
  }),
  generateTitle: vi.fn(async () => 'Recorded title'),
  generateConversationTitle: vi.fn(async () => {
    H.timeline.push('persist:titleAsync');
    return 'Recorded title';
  }),
}));

vi.mock('../../../lib/notification-service.js', () => ({
  sendNotification: vi.fn(async () => {
    H.timeline.push('notify:disconnectedClient');
  }),
}));

vi.mock('../../../lib/credit-anomaly.js', () => ({
  detectCreditAnomaly: vi.fn(async () => null),
}));

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

vi.mock('../../../db/memory/userMemoryRepository.js', () => ({
  findUserMemory: vi.fn(async () => H.state.userMemory),
}));

/**
 * The chat repositories, stubbed at the module boundary the way the Mongoose
 * models were. `getDb()` is mocked to `{}` above, so a real repository call
 * would throw on `db.select` — and the failure would be SILENT here, because
 * every caller in this flow catches: `request-context.ts` `.catch(() => null)`,
 * `chat-lifecycle.ts` around the title, `provider-loop.ts` around the save.
 * Measured while porting: without these, the flow drops its `alia.title` frame
 * and the transcript below is two entries short.
 */
vi.mock('../../../db/chat/conversationRepository.js', () => ({
  conversationExists: vi.fn(async () => false),
  updateConversationTitle: vi.fn(async () => 1),
  upsertConversation: vi.fn(async () => ({})),
}));
vi.mock('../../../db/chat/messageRepository.js', () => ({
  messageExistsInConversation: vi.fn(async () => false),
  countMessages: vi.fn(async () => 0),
  countMessagesInConversation: vi.fn(async () => 0),
  findLastMessage: vi.fn(async () => undefined),
  insertMessages: vi.fn(async () => undefined),
  deleteMessages: vi.fn(async () => 0),
}));
vi.mock('../../../db/agents/skillRepository.js', () => ({
  findSkillPrompt: vi.fn(async () => undefined),
}));
vi.mock('../../../db/agents/agentRepository.js', () => ({ findAgentById: vi.fn(async () => null) }));

vi.mock('../../../lib/tools/mcp.js', () => ({ buildMcpTools: vi.fn(async () => ({})) }));
vi.mock('../../../lib/tools/integrations.js', () => ({ buildIntegrationTools: vi.fn(async () => ({})) }));
vi.mock('../../../lib/tools/oxy-services.js', () => ({
  buildOxyServiceTools: vi.fn(async () => ({})),
  getOxyServicePromptFragment: vi.fn(async () => ''),
  getOxyServiceContext: vi.fn(async () => ''),
}));

/**
 * The one tool mocked by MODULE rather than executed: it is the only tool in the
 * default set that opens a socket. The research engine imports it from here
 * directly (`lib/research/research-engine.ts:17`), so this covers both callers.
 */
vi.mock('../../../lib/tools/web-search.js', () => ({
  webSearchTool: {
    description: 'search',
    execute: vi.fn(async () => {
      H.timeline.push('tool:webSearch');
      return { results: H.state.searchResults };
    }),
  },
}));

vi.mock('../../../lib/observability/index.js', () => ({
  recordEvent: vi.fn((event: { type: string }) => {
    H.timeline.push(`observe:${event.type}`);
  }),
}));

vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, chat: child, general: child, providers: child, codea: child, correlation: child } };
});

// ── Import the route AFTER the mocks ───────────────────────────────────────

import { handleChatCompletions } from '../chat-completions.js';
import { resolveModel } from '../../../lib/chat-core.js';

// ── Frame classification: the recorder, pinned by its own tests below ───────

interface ParsedChunk {
  object?: string;
  error?: { code?: string };
  choices?: Array<{ delta?: { content?: string; tool_calls?: unknown[] }; finish_reason?: string | null }>;
  usage?: unknown;
}

/**
 * Turn one raw `res.write` payload into a stable label.
 *
 * Classification reads the BYTES. A frame whose payload changes shape gets a
 * different label and every transcript equality below fails — which is the point.
 */
function classifyFrame(raw: string): string {
  if (raw.startsWith(':')) return `sse:comment(${raw.slice(1).trim()})`;
  if (raw.startsWith('event: ')) return `sse:event:${raw.slice(7, raw.indexOf('\n'))}`;
  if (!raw.startsWith('data: ')) return `sse:UNRECOGNISED(${raw})`;

  const body = raw.slice(6).trim();
  if (body === '[DONE]') return 'sse:[DONE]';

  let parsed: ParsedChunk;
  try {
    parsed = JSON.parse(body) as ParsedChunk;
  } catch {
    return `sse:UNPARSEABLE(${body})`;
  }
  if (parsed.error) return `sse:error(${parsed.error.code ?? 'null'})`;

  const choice = parsed.choices?.[0];
  if (!choice) return parsed.usage ? 'sse:chunk:usage' : 'sse:chunk:empty';
  if (choice.delta?.tool_calls) return 'sse:chunk:tool_calls';
  if (typeof choice.delta?.content === 'string') return 'sse:chunk:content';
  if (choice.finish_reason) return `sse:chunk:finish(${choice.finish_reason})`;
  return 'sse:chunk:other';
}

// ── Request/response doubles that record into the shared timeline ───────────

interface RecordingRes {
  setHeader(name: string, value: string): void;
  write(chunk: string): boolean;
  end(): void;
  flushHeaders(): void;
  status(code: number): RecordingRes;
  json(body: unknown): void;
  headersSent: boolean;
  writableEnded: boolean;
  socket: { setNoDelay: (on: boolean) => void };
  readonly raw: string[];
  readonly headers: Record<string, string>;
  readonly jsonBody: unknown;
}

function recordingRes(): RecordingRes {
  const raw: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    raw,
    headers,
    jsonBody: undefined as unknown,
    headersSent: false,
    writableEnded: false,
    socket: { setNoDelay: () => undefined },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    write(chunk: string) {
      raw.push(chunk);
      H.timeline.push(classifyFrame(chunk));
      res.headersSent = true;
      return true;
    },
    end() {
      res.writableEnded = true;
      H.timeline.push('http:end');
    },
    flushHeaders() {
      res.headersSent = true;
    },
    status(code: number) {
      H.timeline.push(`http:status(${code})`);
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      res.headersSent = true;
      H.timeline.push('http:json');
    },
  };
  return res;
}

interface RecordingReq {
  user?: { id: string };
  apiKey?: { id: string };
  serviceApp?: unknown;
  accessToken?: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  socket: { destroyed: boolean };
  on(event: string, listener: () => void): void;
  off(event: string, listener: () => void): void;
  /** Fire the Express `close` event the provider loop subscribes to. */
  disconnect(): void;
}

function recordingReq(overrides: Partial<RecordingReq> & { body: Record<string, unknown> }): RecordingReq {
  const listeners = new Map<string, Set<() => void>>();
  return {
    user: { id: 'user-ws13' },
    accessToken: undefined,
    headers: {},
    socket: { destroyed: false },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    disconnect() {
      H.timeline.push('client:disconnect');
      for (const listener of listeners.get('close') ?? []) listener();
    },
    ...overrides,
  };
}

/** The route's Express types are wider than the doubles; the doubles carry what it reads. */
type RouteReq = Parameters<typeof handleChatCompletions>[0];
type RouteRes = Parameters<typeof handleChatCompletions>[1];
const run = (req: RecordingReq, res: RecordingRes): Promise<void> =>
  handleChatCompletions(req as unknown as RouteReq, res as unknown as RouteRes);

// ── Scripted provider turns ────────────────────────────────────────────────

const streamStart = { type: 'stream-start', warnings: [] };
const finish = (reason = 'stop') => ({ type: 'finish', usage: V3_USAGE, finishReason: reason });
const say = (id: string, text: string) => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: text },
  { type: 'text-end', id },
];
const callTool = (id: string, toolName: string, input: string) => [
  { type: 'tool-input-start', id, toolName },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName, input },
];

const RESOLVED = {
  routingProfileId: 'kaana-v1',
  provider: UPSTREAM_PROVIDER,
  modelId: UPSTREAM_MODEL_ID,
  keyConfig: { provider: UPSTREAM_PROVIDER, key: 'secret-not-for-clients', modelId: UPSTREAM_MODEL_ID, keyId: 'key-ws13' },
  routingProfile: { name: 'Kaana V1', creditMultiplier: 1 },
  isFallback: false,
  fallbackIndex: 0,
};

const RESERVATION = { userId: 'user-ws13', creditsReserved: 1, initialFreeCredits: 100, initialPaidCredits: 0 };

const ENTITLEMENTS = {
  tier: 'free',
  features: {},
  allowedModelIds: ['kaana-v1', 'kaana-lite', 'kaana-v1-codea', 'kaana-v1-cowork'],
};

/**
 * Two editor tools, chosen to cover both halves of the name contract.
 *
 * `read_file` is verbatim what Cowork sends (`packages/alia-cowork/src/main/
 * chat.ts:162`) and passes through `sanitizeFunctionName` unchanged.
 * `workspace/write_file` carries a character the sanitiser rewrites
 * (`lib/tool-converter.ts:29` keeps only `[a-zA-Z0-9_.\-:]`), so it is the one
 * that proves the mapping is restored on the way out rather than being an
 * identity that happens to look right.
 */
const EDITOR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the filesystem',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace/write_file',
      description: 'Write a file into the workspace',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

beforeEach(() => {
  H.timeline.length = 0;
  H.afterChat.length = 0;
  H.state.streamTurns = [];
  H.state.generateContent = [];
  H.state.generateFinishReason = 'stop';
  H.state.resolveAnswers = [RESOLVED];
  H.state.reservation = RESERVATION;
  H.state.entitlements = ENTITLEMENTS;
  H.state.recalledMemories = undefined;
  H.state.userMemory = null;
  H.state.searchResults = [];
  H.state.calls.length = 0;
  H.state.onModelCall = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// The recorder's own positive controls
// ===========================================================================

/**
 * A transcript that reads nothing prints the same tidy result as a flow that
 * emitted nothing, so the classifier is pinned against literal frames before any
 * fixture uses it. Every shape here is one the route actually writes; the file
 * and line that writes it is named, so a reader can check the claim rather than
 * take it.
 */
describe('the frame classifier recognises every shape the route writes', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [': keep-alive\n\n', 'sse:comment(keep-alive)', 'lib/chat/sse-writer.ts:36 (early open)'],
    [': keepalive\n\n', 'sse:comment(keepalive)', 'lib/chat/sse-writer.ts:72 (keep-alive timer)'],
    ['data: [DONE]\n\n', 'sse:[DONE]', 'lib/chat/sse-writer.ts:85 and provider-loop.ts:332'],
    [
      'event: alia.tool_result\ndata: {"eventVersion":1}\n\n',
      'sse:event:alia.tool_result',
      'lib/chat/stream-runner.ts:234',
    ],
    [
      `data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`,
      'sse:chunk:content',
      'lib/streaming-helpers.ts:165 writeTextChunk',
    ],
    [
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[]},"finish_reason":null}]}\n\n`,
      'sse:chunk:tool_calls',
      'lib/chat/stream-runner.ts:197',
    ],
    [
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
      'sse:chunk:finish(stop)',
      'lib/streaming-helpers.ts:173 writeStopChunk',
    ],
    [
      `data: {"choices":[],"usage":{"total_tokens":16}}\n\n`,
      'sse:chunk:usage',
      'lib/chat/provider-loop.ts:291-314',
    ],
    [
      `data: {"error":{"message":"x","code":"INSUFFICIENT_CREDITS"}}\n\n`,
      'sse:error(INSUFFICIENT_CREDITS)',
      'lib/chat/sse-writer.ts:50 writeError',
    ],
  ];

  for (const [frame, label, origin] of cases) {
    it(`labels the frame written at ${origin}`, () => {
      expect(classifyFrame(frame)).toBe(label);
    });
  }

  it('does not silently absorb a frame it has never seen', () => {
    // The failure mode this guards: a NEW frame kind classified as an existing
    // label would be invisible to every transcript equality below. An unknown
    // frame gets a loud label instead, so it shows up in the diff.
    expect(classifyFrame('retry: 5000\n\n')).toBe('sse:UNRECOGNISED(retry: 5000\n\n)');
    expect(classifyFrame('data: not json\n\n')).toBe('sse:UNPARSEABLE(not json)');
  });
});

// ===========================================================================
// Fixture 1 — the app chat flow (packages/app, streaming, direct user session)
// ===========================================================================

/**
 * The flow `packages/app/lib/hooks/use-streaming-chat.ts` drives: a signed-in
 * user, `stream: true`, a conversation id, server-side tools.
 *
 * Ownership: `v1-chat-completions-post` is owned by ALIA and "never removed" —
 * the OpenAI shape, the `alia_*` extensions and the named SSE events are the
 * public contract that must be reproduced byte-compatibly on the far side of any
 * inference move (`docs/migration/ownership-matrix.json`).
 */
describe('fixture: app chat flow — streaming, direct user session, one server tool', () => {
  beforeEach(() => {
    H.state.recalledMemories = [{ title: 'Coffee', summary: 'Prefers oat milk.' }];
    H.state.streamTurns = [
      [streamStart, ...callTool('call-1', 'getCurrentDate', '{}'), finish('tool-calls')],
      [streamStart, ...say('t1', 'It is Tuesday.'), finish('stop')],
    ];
  });

  it('emits one exact ordered transcript of frames and side effects', async () => {
    const req = recordingReq({
      body: {
        messages: [{ role: 'user', content: 'what day is it' }],
        model: 'kaana-v1',
        stream: true,
        conversationId: 'conv-ws13',
        stream_options: { include_usage: true },
      },
    });
    const res = recordingRes();

    await run(req, res);

    // A floor first: an empty transcript is what a handler that returned at the
    // top produces, and it is also what a broken recorder produces. The equality
    // below cannot tell those apart on its own.
    expect(H.timeline.length).toBeGreaterThan(15);

    expect(H.timeline).toEqual([
      // Pre-flight: SSE opens BEFORE any async work so the client sees the
      // connection immediately (`lib/chat/request-context.ts:134`).
      'sse:comment(keep-alive)',
      'credits:reserve',
      // Memory recall runs here — before the model call, and its result reaches
      // the system prompt (asserted separately below).
      'recall:beforeChatHooks',
      'observe:agent.start',
      // Turn 1: the model asks for a tool, the SDK runs it, the result is echoed
      // to the client as an Alia product event, then turn 2 speaks.
      'model:doStream',
      'sse:chunk:tool_calls',
      'observe:tool.call',
      'sse:event:alia.tool_result',
      'model:doStream',
      'sse:chunk:content',
      'sse:chunk:finish(stop)',
      // Persistence happens after the stream and BEFORE the terminator, so a
      // client that reconnects on `[DONE]` can already read its own history.
      'persist:conversation("It is Tuesday.")',
      // The title is generated in parallel with the stream and delivered inline
      // once the save has landed (`lib/chat/provider-loop.ts:272-286`). The app
      // writes it straight into the React Query cache, so dropping it leaves
      // stale titles rather than an error — which is why it is pinned here.
      'sse:event:alia.title',
      'credits:finalize',
      'sse:chunk:usage',
      'hooks:afterChat',
      'observe:agent.end',
      'sse:[DONE]',
      'http:end',
    ]);
  });

  it('recall reaches the model call, not merely precedes it', async () => {
    const body = { messages: [{ role: 'user', content: 'what day is it' }], model: 'kaana-v1', stream: true, conversationId: 'conv-ws13' };
    await run(recordingReq({ body: { ...body } }), recordingRes());

    // Ordering alone is a weak claim: a recall that ran first and was then
    // dropped on the floor orders identically. What must survive an inference
    // swap is that the recalled text is IN the prompt the model receives.
    expect(H.timeline.indexOf('recall:beforeChatHooks')).toBeLessThan(H.timeline.indexOf('model:doStream'));
    const withRecall = systemPromptSeenByModel();
    expect(withRecall).toContain('## Recalled Memories');
    expect(withRecall).toContain('- Coffee: Prefers oat milk.');

    // The control the assertion above needs: the same request with nothing
    // recalled produces a system prompt WITHOUT the section. Without this, a
    // heading that turned out to be unconditional boilerplate would satisfy the
    // check while carrying no memory at all.
    H.state.recalledMemories = undefined;
    H.state.calls.length = 0;
    H.state.streamTurns = [[streamStart, ...say('t1', 'It is Tuesday.'), finish('stop')]];
    await run(recordingReq({ body: { ...body } }), recordingRes());
    const withoutRecall = systemPromptSeenByModel();
    expect(withoutRecall.length).toBeGreaterThan(100);
    expect(withoutRecall).not.toContain('## Recalled Memories');
  });

  it('executes the tool for real between the call frame and the result frame', async () => {
    const req = recordingReq({
      body: { messages: [{ role: 'user', content: 'what day is it' }], model: 'kaana-v1', stream: true, conversationId: 'conv-ws13' },
    });
    const res = recordingRes();
    const before = Date.now();

    await run(req, res);

    const toolResult = namedEvent(res, 'alia.tool_result');
    expect(toolResult.name).toBe('getCurrentDate');
    expect(toolResult.tool_call_id).toBe('call-1');

    // The proof that the REAL tool ran rather than a scripted result being
    // echoed: `getCurrentDateTool` (lib/tools/date.ts:11) stamps `Date.now()`.
    // The instant is written relative to the test's own clock — a fixture with a
    // hardcoded date is a time bomb for every sibling file.
    const output = toolResult.output as { timestamp?: string };
    expect(typeof output.timestamp).toBe('string');
    const stamped = Date.parse(String(output.timestamp));
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);

    // The tool-call frame is a GENERIC OpenAI frame; the result is an ALIA one.
    // That split is the contract: an OpenAI SDK parser sees the call and ignores
    // the result, so moving the result into a `data:` frame is a breaking change
    // for the app and the published SDK alike.
    const kinds = H.timeline.filter((entry) => entry.startsWith('sse:'));
    expect(kinds.indexOf('sse:chunk:tool_calls')).toBeLessThan(kinds.indexOf('sse:event:alia.tool_result'));
  });

  it('names the Alia product events it emits, and no others', async () => {
    const req = recordingReq({
      body: {
        messages: [{ role: 'user', content: 'what day is it' }],
        model: 'kaana-v1',
        stream: true,
        conversationId: 'conv-ws13',
        stream_options: { include_usage: true },
      },
    });
    const res = recordingRes();
    await run(req, res);

    // Positive control: the scan sees a named event at all. Without it, "no
    // unexpected events" is what a scan of an empty array also reports.
    const named = res.raw.filter((frame) => frame.startsWith('event: ')).map((frame) => frame.slice(7, frame.indexOf('\n')));
    expect(named).toEqual(['alia.tool_result', 'alia.title']);

    // The generic half: every `data:` frame that is not the terminator carries
    // the OpenAI chunk envelope, and the model field is the ALIA ALIAS — never
    // the upstream id. This is the model-abstraction invariant, measured on the
    // bytes rather than trusted.
    const dataFrames = res.raw
      .filter((frame) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
      .map((frame) => JSON.parse(frame.slice(6).trim()) as { object?: string; model?: string });
    expect(dataFrames.length).toBeGreaterThan(0);
    expect(new Set(dataFrames.map((frame) => frame.object))).toEqual(new Set(['chat.completion.chunk']));
    expect(new Set(dataFrames.map((frame) => frame.model))).toEqual(new Set(['kaana-v1']));

    // And the same invariant over the WHOLE byte stream, named events included.
    // This is the successful path deliberately: on the all-providers-exhausted
    // path `state.resolved` has already been reset to null, so a leak planted
    // there renders as the string "null" and leaks nothing — measured, by
    // mutating exactly that line and watching it survive. The place a provider
    // identity can actually escape is a request that resolved.
    const bytes = res.raw.join('');
    expect(bytes).toContain('kaana-v1');
    expect(bytes).not.toContain(UPSTREAM_PROVIDER);
    expect(bytes).not.toContain(UPSTREAM_MODEL_ID);
  });

  it('does not emit an approval request over SSE — approvals are a socket surface', async () => {
    const req = recordingReq({
      body: { messages: [{ role: 'user', content: 'what day is it' }], model: 'kaana-v1', stream: true, conversationId: 'conv-ws13' },
    });
    const res = recordingRes();
    await run(req, res);

    // `packages/app/lib/hooks/use-streaming-chat.ts:543` parses
    // `alia.approval_request` as an SSE case, but the only emitter in the
    // package is Socket.IO (`src/socket.ts:215`). Recording that here means a
    // future change that starts emitting it over SSE is a deliberate edit to
    // this fixture rather than an accident.
    //
    // The vacuity floor for a negative: the same scan DID find a named event in
    // the assertion above, so "absent" here is absence, not blindness.
    const named = res.raw.filter((frame) => frame.startsWith('event: '));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((frame) => frame.includes('alia.approval'))).toEqual([]);
  });

  it('keeps generating after the client disconnects, then notifies', async () => {
    // Cancellation semantics, measured: the route subscribes to `close`
    // (`lib/chat/provider-loop.ts:213`) but the listener only sets a flag. The
    // stream is NOT aborted, the conversation is still saved, `[DONE]` is still
    // written, and the user gets a push instead. Anything that swaps this for a
    // real abort changes what the user receives, so it is pinned rather than
    // assumed.
    const req = recordingReq({
      body: {
        messages: [{ role: 'user', content: 'what day is it' }],
        model: 'kaana-v1',
        stream: true,
        conversationId: 'conv-ws13',
      },
    });
    const res = recordingRes();
    // Fired from inside the SECOND model call, which is after the provider loop
    // has subscribed to `close`. Disconnecting before `run()` returns its first
    // await would be a disconnect nobody is listening for — a test that passes
    // for the wrong reason.
    H.state.onModelCall = (callIndex) => {
      if (callIndex === 2) req.disconnect();
    };

    await run(req, res);

    expect(H.timeline).toContain('client:disconnect');
    expect(H.timeline).toContain('persist:conversation("It is Tuesday.")');
    expect(H.timeline).toContain('sse:[DONE]');
    expect(H.timeline).toContain('notify:disconnectedClient');
    // The notification comes after the terminator, so a client that reconnects
    // has already seen the full answer.
    expect(H.timeline.indexOf('sse:[DONE]')).toBeLessThan(H.timeline.indexOf('notify:disconnectedClient'));
  });

  it('synthesizes an answer when all five bounded steps were tool calls', async () => {
    H.state.streamTurns = [
      ...Array.from({ length: 5 }, (_, index) => [
        streamStart,
        ...callTool(`weather-${index}`, 'getCurrentDate', '{}'),
        finish('tool-calls'),
      ]),
      [streamStart, ...say('weather-answer', 'Barcelona is sunny and mild today.'), finish('stop')],
    ];

    const res = recordingRes();
    await run(recordingReq({
      body: {
        messages: [{ role: 'user', content: 'what is the weather in Barcelona?' }],
        model: 'kaana-v1',
        stream: true,
        conversationId: 'conv-weather',
      },
    }), res);

    expect(H.timeline.filter(entry => entry === 'model:doStream')).toHaveLength(6);
    expect(res.raw.join('')).toContain('Barcelona is sunny and mild today.');
    expect(H.timeline).toContain('persist:conversation("Barcelona is sunny and mild today.")');
    expect(H.timeline).toContain('credits:finalize');
    expect(res.raw.join('')).not.toContain('"synthetic":true');
  });

  it('does not save or bill tool progress when the tools-disabled synthesis is empty', async () => {
    H.state.streamTurns = [
      ...Array.from({ length: 5 }, (_, index) => [
        streamStart,
        ...callTool(`weather-${index}`, 'getCurrentDate', '{}'),
        finish('tool-calls'),
      ]),
      [streamStart, finish('stop')],
    ];

    const res = recordingRes();
    await run(recordingReq({
      body: {
        messages: [{ role: 'user', content: 'what is the weather in Barcelona?' }],
        model: 'kaana-v1',
        stream: true,
        conversationId: 'conv-weather-empty',
      },
    }), res);

    expect(H.timeline.filter(entry => entry === 'model:doStream')).toHaveLength(6);
    expect(H.timeline.filter(entry => entry.startsWith('persist:'))).toEqual([]);
    expect(H.timeline).not.toContain('credits:finalize');
    expect(H.timeline).toContain('credits:refund');
    expect(res.raw.join('')).toContain('"synthetic":true');
    expect(res.raw.join('')).toContain('"retryable":true');
  });
});

// ===========================================================================
// Fixture 2 — failure surface, shared by every flow
// ===========================================================================

describe('fixture: what a failure surfaces to the user', () => {
  it('exhausting every provider yields a synthetic answer, never a raw error', async () => {
    // Reachable in production: this is the path a tier-wide provider outage
    // takes. The route's own comment calls it the LAST-RESORT SYNTHETIC RESPONSE
    // (`routes/v1/chat-completions.ts:270`).
    H.state.resolveAnswers = [RESOLVED, null];
    H.state.streamTurns = [[streamStart, { type: 'error', error: new Error('upstream exploded') }]];

    const req = recordingReq({
      body: { messages: [{ role: 'user', content: 'summarise this file' }], model: 'kaana-v1', stream: true },
    });
    const res = recordingRes();
    await run(req, res);

    const bytes = res.raw.join('');
    // Product-visible: a friendly message, marked synthetic and retryable, then
    // a normal stop chunk and the terminator. A client that only reads content
    // sees prose, not a stack trace.
    expect(bytes).toContain('all models are currently busy');
    expect(bytes).toContain('"synthetic":true');
    expect(bytes).toContain('"retryable":true');
    expect(H.timeline).toContain('credits:refund');
    expect(H.timeline.at(-1)).toBe('http:end');
    expect(H.timeline.at(-2)).toBe('sse:[DONE]');

    // No provider identity anywhere in the bytes. The positive control for this
    // scan is the line below it: the alias IS present, so the scan reads the
    // stream rather than an empty string.
    expect(bytes).not.toContain(UPSTREAM_PROVIDER);
    expect(bytes).not.toContain(UPSTREAM_MODEL_ID);
    expect(bytes).toContain('kaana-v1');
  });

  /**
   * #139 workstream 19: *"Record ... error class and cancellation."*
   *
   * The mechanism-green-and-inert check for the failure half. Before this, the
   * after-chat hooks ran on the two SUCCESS paths only, so a turn that
   * exhausted every provider left no usage record at all — the `error_class`
   * column would have been null on every row that existed, and a repository
   * test writing a class it was handed would have said nothing about it.
   */
  it('records the failed turn, with the class it failed as', async () => {
    H.state.resolveAnswers = [RESOLVED, null];
    H.state.streamTurns = [[streamStart, { type: 'error', error: new Error('upstream exploded') }]];

    await run(
      recordingReq({
        body: { messages: [{ role: 'user', content: 'summarise this file' }], model: 'kaana-v1', stream: true },
      }),
      recordingRes(),
    );

    expect(H.afterChat).toHaveLength(1);
    const [recorded] = H.afterChat;
    expect(recorded.errorClass).toBe('PROVIDER_UNAVAILABLE');
    // The response is empty because nothing usable reached the caller, which is
    // also what the autonomy learner reads to score the run.
    expect(recorded.response).toBe('');
    expect(recorded.requestedModel).toBe('kaana-v1');
    expect(recorded.cancelled).toBe(false);
  });

  it('records a successful turn with no error class and a first-token time', async () => {
    // The discriminator for the case above. Without it, `errorClass` being set
    // is equally consistent with a route that stamps a class on every turn.
    H.state.streamTurns = [[streamStart, ...say('t1', 'Here you go.'), finish('stop')]];

    await run(
      recordingReq({ body: { messages: [{ role: 'user', content: 'hello' }], model: 'kaana-v1', stream: true } }),
      recordingRes(),
    );

    expect(H.afterChat).toHaveLength(1);
    const [recorded] = H.afterChat;
    expect(recorded.errorClass).toBeNull();
    expect(recorded.cancelled).toBe(false);
    // A number, not null: the streaming path timed a first chunk. `>= 0`
    // because a test process can produce the whole stream inside one
    // millisecond, and the property under test is that it was MEASURED.
    expect(typeof recorded.timeToFirstTokenMs).toBe('number');
    expect(recorded.timeToFirstTokenMs as number).toBeGreaterThanOrEqual(0);
  });

  it('answers in the language of the last user message', async () => {
    // Same path, Spanish input. The branch is in the route
    // (`routes/v1/chat-completions.ts:238,275`) and it is product-visible.
    H.state.resolveAnswers = [RESOLVED, null];
    H.state.streamTurns = [[streamStart, { type: 'error', error: new Error('upstream exploded') }]];

    const spanish = recordingRes();
    await run(recordingReq({ body: { messages: [{ role: 'user', content: 'hola, ¿qué tal?' }], model: 'kaana-v1', stream: true } }), spanish);
    expect(spanish.raw.join('')).toContain('todos los modelos están ocupados');

    H.timeline.length = 0;
    H.state.resolveAnswers = [RESOLVED, null];
    H.state.streamTurns = [[streamStart, { type: 'error', error: new Error('upstream exploded') }]];
    const english = recordingRes();
    await run(recordingReq({ body: { messages: [{ role: 'user', content: 'how are you' }], model: 'kaana-v1', stream: true } }), english);
    expect(english.raw.join('')).toContain('all models are currently busy');
  });

  it('refuses before the model call when credits are exhausted', async () => {
    H.state.reservation = null;
    const res = recordingRes();
    await run(recordingReq({ body: { messages: [{ role: 'user', content: 'hi' }], model: 'kaana-v1', stream: false } }), res);

    expect(H.timeline).toEqual(['credits:reserve', 'http:status(402)', 'http:json']);
    expect(res.jsonBody).toEqual({
      error: {
        message: "You've run out of credits. Add more or upgrade your plan to continue.",
        type: 'invalid_request_error',
        param: null,
        code: 'INSUFFICIENT_CREDITS',
      },
    });
  });

  it('refuses over the open stream when credits are exhausted mid-flight of a streaming request', async () => {
    // The same gate, different surface: once SSE headers are out the refusal
    // cannot be an HTTP status, so it is an OpenAI-shaped error frame followed
    // by the terminator (`lib/chat/sse-writer.ts:50`). A client that only checks
    // HTTP status reports success here — recorded so that is a deliberate
    // property rather than a surprise.
    H.state.reservation = null;
    const res = recordingRes();
    await run(recordingReq({ body: { messages: [{ role: 'user', content: 'hi' }], model: 'kaana-v1', stream: true } }), res);

    expect(H.timeline).toEqual([
      'sse:comment(keep-alive)',
      'credits:reserve',
      'sse:error(INSUFFICIENT_CREDITS)',
      'sse:[DONE]',
      'http:end',
    ]);
  });

  it('refuses a model the plan does not allow, and refunds', async () => {
    H.state.entitlements = { tier: 'free', features: {}, allowedModelIds: ['kaana-lite'] };
    const res = recordingRes();
    await run(recordingReq({ body: { messages: [{ role: 'user', content: 'hi' }], model: 'kaana-v1', stream: false } }), res);

    expect(H.timeline).toEqual(['credits:reserve', 'credits:refund', 'http:status(403)', 'http:json']);
    expect(res.jsonBody).toEqual({
      error: { message: 'Upgrade your plan to use this model.', type: 'invalid_request_error', param: 'model', code: 'MODEL_NOT_IN_PLAN' },
    });
  });
});

// ===========================================================================
// Fixture 3 — Codea (VS Code extension), API key, non-streaming completion
// ===========================================================================

/**
 * `packages/alia-codea/src/inlineCompletionProvider.ts:93` posts to
 * /v1/chat/completions with `stream: false`, `max_tokens: 500` and no tools,
 * and reads `choices[0].message.content`. `chatProvider.ts:812,968` branches on
 * `alia_meta.synthetic` to suppress a bogus answer — which is why the synthetic
 * marker is part of Codea's contract and not an implementation detail
 * (`response-ext-alia-meta`, owned by Alia).
 */
describe('fixture: Codea flow — API key, non-streaming, no client tools', () => {
  const codeaReq = (body: Record<string, unknown>) =>
    recordingReq({ apiKey: { id: 'key-ws13' }, user: { id: 'user-ws13' }, body });

  beforeEach(() => {
    H.state.resolveAnswers = [{ ...RESOLVED, routingProfileId: 'kaana-v1-codea' }];
    H.state.generateContent = [{ type: 'text', text: 'const total = items.length;' }];
  });

  it('emits one exact ordered transcript and an OpenAI completion envelope', async () => {
    const res = recordingRes();
    await run(
      codeaReq({
        messages: [
          { role: 'system', content: 'You are an expert code completion assistant.' },
          { role: 'user', content: 'complete this' },
        ],
        model: 'kaana-v1-codea',
        max_tokens: 500,
        temperature: 0.2,
        stream: false,
      }),
      res,
    );

    expect(H.timeline).toEqual([
      'credits:reserve',
      'recall:beforeChatHooks',
      'observe:agent.start',
      'model:doGenerate',
      'credits:finalize',
      'hooks:afterChat',
      'http:json',
    ]);

    // No SSE at all: an editor asking for a completion must not receive an
    // event stream (`lib/chat/request-context.ts:134` gates on `stream === true`).
    expect(res.raw).toEqual([]);

    const body = res.jsonBody as {
      object?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      alia_usage?: Record<string, unknown>;
    };
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('kaana-v1-codea');
    expect(body.choices?.[0].message?.content).toBe('const total = items.length;');
    // The Alia extension the app reads with a fallback to the standard block; a
    // rename degrades credit reporting silently rather than erroring
    // (`response-ext-alia-usage`).
    expect(body.alia_usage).toEqual({
      system_prompt_tokens: expect.any(Number),
      billable_tokens: expect.any(Number),
      credits_charged: 3,
      credits_remaining: 97,
      credit_warning: null,
    });
  });

  it('carries the synthetic marker Codea branches on when every provider fails', async () => {
    H.state.resolveAnswers = [{ ...RESOLVED, routingProfileId: 'kaana-v1-codea' }, null];
    const boom = new Error('upstream exploded');
    H.state.generateContent = [];
    const { getAIModel } = await import('../../../lib/chat-core.js');
    vi.mocked(getAIModel).mockReturnValueOnce({
      specificationVersion: 'v3',
      provider: UPSTREAM_PROVIDER,
      modelId: UPSTREAM_MODEL_ID,
      supportedUrls: {},
      doGenerate: async () => {
        H.timeline.push('model:doGenerate');
        throw boom;
      },
      doStream: async () => {
        throw boom;
      },
    } as never);

    const res = recordingRes();
    await run(codeaReq({ messages: [{ role: 'user', content: 'complete this' }], model: 'kaana-v1-codea', stream: false }), res);

    const body = res.jsonBody as { alia_meta?: Record<string, unknown>; choices?: Array<{ message?: { content?: string } }> };
    expect(body.alia_meta).toEqual({ synthetic: true, retryable: true });
    expect(body.choices?.[0].message?.content).toContain('all models are currently busy');
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_PROVIDER);
  });

  it('gives an API-key session no personal tools and no plan gate', async () => {
    // The product difference between an editor session and an app session, and
    // the reason both are pinned separately: an API-key request acts for NOBODY
    // — `actsForPerson` is false — so `ToolPipeline` withholds memory,
    // messaging, triggers, MCP, integrations and Oxy services. A developer key
    // carries its owner's `userId`, so without that gate every one of them
    // would run and hand the key HOLDER the key OWNER's data.
    //
    // The SSE-emitting tools are withheld separately, on `isDirectSession`:
    // they push frames only Alia's own composer renders.
    //
    // `canvas` IS here, and is the one addition. It was reachable only through
    // the Telegram assembler before the five became one, for no reason anybody
    // chose — it is a pure formatter with no user data and no side effect, so
    // an editor client gets it like everyone else.
    H.state.entitlements = { tier: 'free', features: {}, allowedModelIds: [] };
    const res = recordingRes();
    await run(codeaReq({ messages: [{ role: 'user', content: 'complete this' }], model: 'kaana-v1-codea', stream: false }), res);

    // An empty allow-list would have refused an app request; the editor request
    // is served, because the plan gate is skipped for API keys.
    expect(H.timeline).toContain('model:doGenerate');
    expect(toolNamesSeenByModel().sort()).toEqual([
      'browse', 'canvas', 'generateFile', 'getCurrentDate', 'webScraper', 'webSearch',
    ]);
  });
});

// ===========================================================================
// Fixture 4 — Cowork (Electron desktop), API key, streaming, client tools
// ===========================================================================

/**
 * `packages/alia-cowork/src/main/chat.ts` drives an `openai` client at
 * `${baseUrl}/v1` with `stream: true`, `model: 'kaana-v1-cowork'` and its own
 * filesystem tools, then executes the returned tool calls locally.
 *
 * The property that matters most for this flow is the NAME ROUND TRIP: Alia
 * sanitises a client tool name for provider compatibility
 * (`lib/tool-converter.ts:27`) and must hand the ORIGINAL name back, or Cowork
 * cannot dispatch the call.
 */
describe('fixture: Cowork flow — API key, streaming, client-supplied editor tools', () => {
  const coworkReq = (body: Record<string, unknown>) =>
    recordingReq({ apiKey: { id: 'key-ws13' }, user: { id: 'user-ws13' }, body });

  const COWORK_BODY = {
    messages: [{ role: 'user', content: 'read the readme' }],
    model: 'kaana-v1-cowork',
    stream: true,
    tools: EDITOR_TOOLS,
  };

  beforeEach(() => {
    H.state.resolveAnswers = [{ ...RESOLVED, routingProfileId: 'kaana-v1-cowork' }];
    H.state.streamTurns = [
      [streamStart, ...callTool('call-fs', 'workspace_write_file', '{"path":"README.md"}'), finish('tool-calls')],
      [streamStart, ...say('t1', 'The readme describes the project.'), finish('stop')],
    ];
  });

  it('emits one exact ordered transcript', async () => {
    const res = recordingRes();
    await run(coworkReq({ ...COWORK_BODY }), res);

    expect(H.timeline.length).toBeGreaterThan(10);
    expect(H.timeline).toEqual([
      'sse:comment(keep-alive)',
      'credits:reserve',
      'recall:beforeChatHooks',
      'observe:agent.start',
      'model:doStream',
      'sse:chunk:tool_calls',
      'observe:tool.call',
      'sse:event:alia.tool_result',
      'model:doStream',
      'sse:chunk:content',
      'sse:chunk:finish(stop)',
      'credits:finalize',
      'hooks:afterChat',
      'observe:agent.end',
      'sse:[DONE]',
      'http:end',
    ]);

    // No conversation id, so nothing is persisted and no title event is sent —
    // the desktop app owns its own history.
    expect(H.timeline.filter((entry) => entry.startsWith('persist:'))).toEqual([]);
    expect(res.raw.filter((frame) => frame.includes('alia.title'))).toEqual([]);
  });

  it('hands the client its ORIGINAL tool name back, on both frames', async () => {
    const res = recordingRes();
    await run(coworkReq({ ...COWORK_BODY }), res);

    // The model was offered the SANITISED names; Cowork's own `read_file`
    // survives untouched, and the slash-namespaced one is rewritten.
    expect(toolNamesSeenByModel()).toContain('read_file');
    expect(toolNamesSeenByModel()).toContain('workspace_write_file');
    expect(toolNamesSeenByModel()).not.toContain('workspace/write_file');

    // ...and the client is handed the ORIGINAL on the generic tool-call frame
    // AND on the Alia result event. Cowork dispatches on this string; a
    // regression here is a desktop app that silently stops executing tools.
    const call = JSON.parse(res.raw.find((f) => f.includes('tool_calls'))?.slice(6).trim() ?? '{}') as {
      choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    };
    const fn = call.choices?.[0].delta?.tool_calls?.[0];
    expect(fn?.id).toBe('call-fs');
    expect(fn?.function?.name).toBe('workspace/write_file');
    expect(JSON.parse(String(fn?.function?.arguments))).toEqual({ path: 'README.md' });

    const result = namedEvent(res, 'alia.tool_result');
    expect(result.name).toBe('workspace/write_file');
    // An editor tool's server-side executor is an ECHO (lib/tool-converter.ts:76):
    // Alia does not execute it, the client does. That echo is what tells Cowork
    // which local handler to run.
    expect(result.output).toEqual({
      _originalToolName: 'workspace/write_file',
      _sanitizedToolName: 'workspace_write_file',
      params: { path: 'README.md' },
    });
  });

  it('never emits a reasoning delta inside a generic chunk', async () => {
    // `cowork-chat-consumer` in the ownership matrix records that Cowork reads
    // `delta.reasoning`, a field documented nowhere. Measured here: the server
    // has exactly one reasoning surface and it is the NAMED event, so Cowork's
    // reader is dead code today. Recording it means a future change that starts
    // emitting `delta.reasoning` is a deliberate edit to this fixture.
    H.state.streamTurns = [
      [
        streamStart,
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'weighing the options' },
        { type: 'reasoning-end', id: 'r1' },
        ...say('t1', 'Done.'),
        finish('stop'),
      ],
    ];
    const res = recordingRes();
    await run(coworkReq({ ...COWORK_BODY, tools: undefined }), res);

    // Positive control: the reasoning DID travel, as a named Alia event.
    expect(namedEvent(res, 'alia.reasoning')).toEqual({ eventVersion: 1, content: 'weighing the options' });

    const deltas = res.raw
      .filter((frame) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
      .map((frame) => JSON.parse(frame.slice(6).trim()) as { choices?: Array<{ delta?: Record<string, unknown> }> })
      .flatMap((frame) => frame.choices ?? [])
      .map((choice) => choice.delta ?? {});
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.filter((delta) => 'reasoning' in delta)).toEqual([]);
  });
});

// ===========================================================================
// Fixture 5 — deep research
// ===========================================================================

/**
 * `deepResearch: true` diverts the request into
 * `lib/chat-modes/deep-research-handler.ts` BEFORE the tool pipeline and before
 * the provider loop (`routes/v1/chat-completions.ts:82`), so none of the
 * fixtures above cover it. Its product surface is the phase sequence carried by
 * `alia.research_progress`, consumed by the app AND by the published SDK
 * (`packages/alia-chat/src/hooks/useAliaChat.ts:300`), which makes it external.
 */
describe('fixture: deep research flow — phase events, report deltas, sources', () => {
  beforeEach(() => {
    H.state.searchResults = [{ url: 'https://example.test/a', title: 'A', snippet: 'first' }];
    // The research engine calls `generateText` four times per pass; the fake
    // model returns the same body each time, so the phase sequence is what is
    // under test rather than the prose.
    H.state.generateContent = [{ type: 'text', text: '["sub one","sub two"]' }];
  });

  const researchReq = () =>
    recordingReq({
      body: {
        messages: [{ role: 'user', content: 'compare the two approaches' }],
        model: 'kaana-v1',
        stream: true,
        deepResearch: true,
        conversationId: 'conv-research',
      },
    });

  it('emits its phases in order and terminates the stream itself', async () => {
    const res = recordingRes();
    await run(researchReq(), res);

    const phases = res.raw
      .filter((frame) => frame.startsWith('event: alia.research_progress'))
      .map((frame) => (JSON.parse(frame.slice(frame.indexOf('data: ') + 6).trim()) as { phase: string }).phase);

    // A floor, so an empty phase list cannot pass as "the phases are fine".
    expect(phases.length).toBeGreaterThanOrEqual(6);
    expect(phases).toEqual([
      'decomposing',
      'decomposing',
      'searching',
      'synthesizing',
      // Two follow-up rounds: `MAX_FOLLOW_UP_ITERATIONS` is 2 and each round
      // re-synthesizes (`lib/research/research-engine.ts:58,153-186`).
      'follow_up',
      'follow_up',
      'finalizing',
      'complete',
      // The seventh is the handler's own sources payload, emitted after the
      // report deltas rather than by the engine (`deep-research-handler.ts:67`).
      'complete',
    ]);

    // The report is streamed as ORDINARY content deltas, not as a named event —
    // so a plain OpenAI client still receives the answer.
    expect(H.timeline.filter((entry) => entry === 'sse:chunk:content').length).toBeGreaterThan(0);

    // The wire sequence closes exactly like every other flow: the last three
    // frames are stop, terminator, end (`lib/chat-modes/deep-research-handler.ts:76-78`).
    const wire = H.timeline.filter((entry) => entry.startsWith('sse:') || entry === 'http:end');
    expect(wire.slice(-3)).toEqual(['sse:chunk:finish(stop)', 'sse:[DONE]', 'http:end']);
  });

  it('sends sources in the final event and never enters the provider loop', async () => {
    const res = recordingRes();
    await run(researchReq(), res);

    const final = JSON.parse(
      res.raw.filter((f) => f.startsWith('event: alia.research_progress')).at(-1)?.split('data: ')[1].trim() ?? '{}',
    ) as { phase: string; sources?: Array<{ id: number; url: string }>; totalSearches?: number; subQuestions?: string[] };
    expect(final.phase).toBe('complete');
    expect(final.sources).toEqual([{ id: 1, url: 'https://example.test/a', title: 'A' }]);
    expect(final.subQuestions).toEqual(['sub one', 'sub two']);
    expect(typeof final.totalSearches).toBe('number');

    // The divert is total: `agent.start`/`agent.end` belong to the provider
    // loop, and neither is recorded here. If research ever starts flowing
    // through the loop the transcript changes, which is the regression this
    // catches.
    expect(H.timeline).not.toContain('observe:agent.start');
    expect(H.timeline).not.toContain('observe:agent.end');
  });

  it('persists the report and finalizes credits after the terminator', async () => {
    const res = recordingRes();
    await run(researchReq(), res);

    // Research closes the stream BEFORE it saves (`deep-research-handler.ts:78`
    // then `:82`), the opposite of the provider loop, which saves first. Both
    // are recorded because a port that unifies them changes when a reconnecting
    // client can read its own history.
    expect(H.timeline.indexOf('sse:[DONE]')).toBeLessThan(H.timeline.findIndex((e) => e.startsWith('persist:conversation')));
    expect(H.timeline).toContain('credits:finalize');
    expect(H.timeline).toContain('persist:titleAsync');
  });

  it('cannot be cancelled by a client disconnect', async () => {
    // MEASURED, and it is a finding rather than a design: the route snapshots
    // the socket state ONCE at `routes/v1/chat-completions.ts:94`
    // (`req.socket.destroyed ? AbortSignal.abort() : undefined`), so the signal
    // handed to the engine is either already aborted or permanently undefined.
    // Every `signal?.aborted` check inside `runDeepResearch` is therefore dead
    // for a mid-flight disconnect.
    const req = researchReq();
    const res = recordingRes();
    const finished = run(req, res);
    req.disconnect();
    await finished;

    // The research still ran to completion and still emitted `complete`.
    const phases = res.raw
      .filter((frame) => frame.startsWith('event: alia.research_progress'))
      .map((frame) => (JSON.parse(frame.slice(frame.indexOf('data: ') + 6).trim()) as { phase: string }).phase);
    expect(phases).toContain('complete');

    // And the control that gives the claim teeth: when the socket IS already
    // destroyed at request time the signal is a real aborted one and the engine
    // refuses, surfacing the sanitised research failure instead.
    H.timeline.length = 0;
    const dead = researchReq();
    dead.socket.destroyed = true;
    const deadRes = recordingRes();
    await run(dead, deadRes);
    expect(deadRes.raw.join('')).toContain('research_failed');
    expect(H.timeline).toContain('credits:refund');
  });

  it('surfaces a research failure without naming a provider', async () => {
    H.state.searchResults = [];
    const { getAIModel } = await import('../../../lib/chat-core.js');
    /**
     * Restored in `finally`, and that is not tidiness.
     *
     * The research engine calls the model several times per pass, so this has
     * to be a standing implementation rather than a `…Once` — and a standing
     * implementation SURVIVES the suite's `vi.clearAllMocks()`, which resets
     * call records and not implementations. Left in place it hands a throwing
     * model to every test declared after this one, and the failure lands on
     * whoever adds the next fixture rather than here.
     */
    const scriptedModel = vi.mocked(getAIModel).getMockImplementation();
    vi.mocked(getAIModel).mockReturnValue({
      specificationVersion: 'v3',
      provider: UPSTREAM_PROVIDER,
      modelId: UPSTREAM_MODEL_ID,
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error(`${UPSTREAM_PROVIDER} refused the request for ${UPSTREAM_MODEL_ID}`);
      },
      doStream: async () => {
        throw new Error('unused');
      },
    } as never);

    const res = recordingRes();
    try {
      await run(researchReq(), res);
    } finally {
      if (scriptedModel) vi.mocked(getAIModel).mockImplementation(scriptedModel);
    }
    const bytes = res.raw.join('');

    // The engine swallows per-step model failures and falls back, so the user
    // still gets a report rather than an error — and either way no provider
    // identity reaches the bytes. Positive control: the alias does.
    expect(bytes).not.toContain(UPSTREAM_PROVIDER);
    expect(bytes).not.toContain(UPSTREAM_MODEL_ID);
    expect(bytes).toContain('kaana-v1');
  });
});

// ===========================================================================
// Helpers that read what the fake model was actually handed
// ===========================================================================

/**
 * The system text in the prompt the model received on its FIRST call.
 *
 * `doStream`/`doGenerate` receive the fully assembled request, so reading it
 * here is what makes "recall reaches the model" and "these tools were offered"
 * measurements of the real assembly rather than of the fixture's own inputs.
 */
function systemPromptSeenByModel(): string {
  const first = H.state.calls[0]?.prompt?.[0];
  if (!first || first.role !== 'system') return '';
  return typeof first.content === 'string' ? first.content : JSON.stringify(first.content);
}

/** The tool names offered to the model on its first call. */
function toolNamesSeenByModel(): string[] {
  return (H.state.calls[0]?.tools ?? []).map((tool) => tool.name);
}

/** Parse the payload of the named SSE event, failing loudly when it is absent. */
function namedEvent(res: RecordingRes, name: string): Record<string, unknown> {
  const frame = res.raw.find((entry) => entry.startsWith(`event: ${name}\n`));
  expect(frame, `expected a ${name} frame`).toBeDefined();
  return JSON.parse(String(frame).slice(String(frame).indexOf('data: ') + 6).trim()) as Record<string, unknown>;
}


// ===========================================================================
// A model served by the person's OWN machine
// ===========================================================================

/**
 * `local/<runtimeId>/<model>` names no Alia route, so the entire resolution,
 * entitlement and billing apparatus has to step aside — while everything ABOVE
 * it (the prompt, recall, the tool pipeline, persistence) runs unchanged. Both
 * halves are asserted here, because either one alone is satisfied by a broken
 * implementation: a turn that bills nothing because it never ran is not the
 * wanted outcome, and neither is a turn that runs and bills.
 */
describe('fixture: a turn served by the user own device', () => {
  const LOCAL_MODEL = 'local/rt-1/llama3.1:8b';

  beforeEach(() => {
    LOCAL.connected = true;
    H.state.streamTurns = [[streamStart, ...say('t1', 'Running on your machine.'), finish('stop')]];
  });

  it('reaches the model and reserves no credits', async () => {
    const req = recordingReq({
      body: {
        messages: [{ role: 'user', content: 'hola' }],
        model: LOCAL_MODEL,
        stream: true,
        conversationId: 'conv-local',
      },
    });
    const res = recordingRes();

    await run(req, res);

    // The floor, in the same currency as the claim below: "no credit frames"
    // and "nothing happened at all" are the same empty transcript otherwise.
    expect(H.timeline).toContain('model:doStream');
    expect(H.timeline.filter((entry) => entry.startsWith('credits:'))).toEqual([]);

    /**
     * Not resolved, not routed. The synthetic resolution in `request-context.ts`
     * is what keeps a local id away from `fallback-engine.ts`, which throws for
     * anything outside `KAANA_ROUTING_PROFILES` — so a regression here does not degrade
     * gracefully, it 500s.
     */
    expect(vi.mocked(resolveModel)).not.toHaveBeenCalled();

    // The id the person selected is the id the response is stamped with. An
    // alias substituted here would be the silent substitution ADR 0003 forbids.
    const chunk = res.raw.find((frame) => frame.includes('"choices"'));
    expect(chunk).toContain(LOCAL_MODEL);
  });

  /**
   * The safety argument for charging nothing, asserted rather than asserted-in-a-comment.
   *
   * A turn that reserves no credits must not be able to reach inference Alia
   * pays for. Both doors are tested: the request FLAG and the TOOL, because
   * closing one and leaving the other open produces a green suite and free
   * hosted inference.
   */
  it('refuses to run deep research, which resolves hosted models by name', async () => {
    const req = recordingReq({
      body: {
        messages: [{ role: 'user', content: 'research this' }],
        model: LOCAL_MODEL,
        stream: true,
        deepResearch: true,
      },
    });
    const res = recordingRes();

    await run(req, res);

    expect(res.jsonBody).toMatchObject({ error: { code: 'local_runtime_capability_unavailable' } });
    // Nothing ran, and nothing was billed to nobody.
    expect(H.timeline).not.toContain('model:doStream');
    expect(H.timeline).not.toContain('model:doGenerate');
    expect(H.timeline.filter((entry) => entry.startsWith('credits:'))).toEqual([]);
  });

  it('refuses agent mode, whose delegation tool resolves a hosted model too', async () => {
    const res = recordingRes();
    await run(
      recordingReq({
        body: { messages: [{ role: 'user', content: 'go' }], model: LOCAL_MODEL, stream: true, agentMode: true },
      }),
      res,
    );
    expect(res.jsonBody).toMatchObject({ error: { code: 'local_runtime_capability_unavailable' } });
    expect(H.timeline).not.toContain('model:doStream');
  });

  it('never offers the deep-research tool, which reaches the same engine', async () => {
    const res = recordingRes();
    await run(
      recordingReq({
        body: { messages: [{ role: 'user', content: 'hola' }], model: LOCAL_MODEL, stream: true },
      }),
      res,
    );
    const local = toolNamesSeenByModel();
    // The floor: a turn with no tools at all would also "not offer" it.
    expect(local).toContain('webSearch');
    expect(local).not.toContain('deepResearch');
  });

  it('positive control: the same request on a Kaana routing profile IS offered it', async () => {
    // Without this the assertion above passes for a build that offers the tool
    // to nobody, which would be a different bug wearing the same green.
    const res = recordingRes();
    await run(
      recordingReq({
        body: { messages: [{ role: 'user', content: 'hola' }], model: 'kaana-v1', stream: true },
      }),
      res,
    );
    expect(toolNamesSeenByModel()).toContain('deepResearch');
  });

  it('refuses before the stream opens when no device is offering it', async () => {
    LOCAL.connected = false;
    const req = recordingReq({
      body: {
        messages: [{ role: 'user', content: 'hola' }],
        model: LOCAL_MODEL,
        stream: true,
      },
    });
    const res = recordingRes();

    await run(req, res);

    /**
     * A refusal the picker can act on, as JSON — not an SSE error frame. The
     * check sits ahead of `sse.openEarly()` precisely so this case does not
     * arrive as a dead stream, and this is what would notice it moving.
     */
    expect(H.timeline).toEqual(['http:status(409)', 'http:json']);
    expect(res.jsonBody).toMatchObject({ error: { code: 'local_runtime_unavailable' } });

    // The mutation control for the test above: the same request with the same
    // fixtures reaches the model when a device IS connected, and nothing here.
    expect(H.timeline).not.toContain('model:doStream');
    expect(H.timeline.filter((entry) => entry.startsWith('credits:'))).toEqual([]);
  });
});
