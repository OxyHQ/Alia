import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared mock state (hoisted alongside vi.mock calls) ─────────────────────

const {
  mockResolveModel,
  mockGetAIModel,
  mockReportModelUsage,
  mockGetDefaultRoutingProfile,
  mockReserveCredits,
  mockFinalizeCredits,
  mockGetOrCreateUserCredits,
  mockStreamText,
  mockGenerateText,
  mockGetUserById,
  mockBuildSystemPrompt,
  mockRefundReservation,
} = vi.hoisted(() => ({
  mockResolveModel: vi.fn(),
  mockGetAIModel: vi.fn(() => 'mock-ai-model'),
  mockReportModelUsage: vi.fn().mockResolvedValue(undefined),
  mockGetDefaultRoutingProfile: vi.fn(() => 'kaana-v1'),
  mockReserveCredits: vi.fn(),
  mockFinalizeCredits: vi.fn().mockResolvedValue({ creditsCharged: 1, creditsRemaining: 99 }),
  mockGetOrCreateUserCredits: vi.fn().mockResolvedValue({}),
  mockStreamText: vi.fn(),
  mockGenerateText: vi.fn(),
  mockGetUserById: vi.fn().mockResolvedValue(null),
  mockBuildSystemPrompt: vi.fn().mockResolvedValue('You are Alia, a helpful AI assistant.'),
  mockRefundReservation: vi.fn().mockResolvedValue(undefined),
}));

// ── Module mocks ───────────────────────────────────────────────────────────

vi.mock('ai', () => ({
  streamText: (...args: any[]) => mockStreamText(...args),
  generateText: (...args: any[]) => mockGenerateText(...args),
  stepCountIs: vi.fn(() => 'mock-stop-condition'),
  tool: vi.fn((def: any) => def),
}));

vi.mock('../../../lib/chat-core.js', () => ({
  resolveModel: (...args: any[]) => mockResolveModel(...args),
  getAIModel: vi.fn(mockGetAIModel),
  getDefaultRoutingProfile: () => mockGetDefaultRoutingProfile(),
  reportModelUsage: (...args: any[]) => mockReportModelUsage(...args),
  isRoutingProfile: vi.fn(() => true),
  getRoutingProfile: vi.fn(() => ({ name: 'Kaana V1', creditMultiplier: 1 })),
  getAllRoutingProfiles: vi.fn(() => []),
  getRoutingProfilesByCategory: vi.fn(() => []),
  getDefaultModelForCategory: vi.fn(() => null),
  getAvailableModels: vi.fn(() => []),
  resolveRoutingProfileWithAttempts: vi.fn(),
}));

vi.mock('../../../internal/providers/lib/routing-profile-catalogue.js', () => ({
  getRoutingProfile: vi.fn(() => ({ name: 'Kaana V1', creditMultiplier: 1 })),
  isRoutingProfile: vi.fn(() => true),
  getAllRoutingProfiles: vi.fn(() => []),
  getRoutingProfilesByCategory: vi.fn(() => []),
  getDefaultModelForCategory: vi.fn(() => null),
  getAvailableModels: vi.fn(() => []),
}));

vi.mock('../../../lib/credits-manager.js', () => ({
  reserveCredits: (...args: any[]) => mockReserveCredits(...args),
  finalizeCredits: (...args: any[]) => mockFinalizeCredits(...args),
  refundReservation: (...args: any[]) => mockRefundReservation(...args),
  // Mirrors the real helper, which refunds through `refundReservation` — so a
  // refund taken by either name lands on the same assertion.
  safeRefund: (reservation: any) => (reservation ? mockRefundReservation(reservation) : Promise.resolve()),
}));

vi.mock('../../../lib/user-credits-helpers.js', () => ({
  getOrCreateUserCredits: (...args: any[]) => mockGetOrCreateUserCredits(...args),
}));

vi.mock('../../../middleware/auth.js', () => ({
  oxyClient: { getUserById: (...args: any[]) => mockGetUserById(...args) },
  optionalAuth: vi.fn((_r: any, _s: any, n: any) => n()),
  authenticateTokenOrApiKey: vi.fn((_r: any, _s: any, n: any) => n()),
  authenticateToken: vi.fn((_r: any, _s: any, n: any) => n()),
}));

vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../../db/memory/userMemoryRepository.js', () => ({
  findUserMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../db/agents/skillRepository.js', () => ({
  findSkillPrompt: vi.fn().mockResolvedValue(undefined),
}));

/**
 * `getDb()` is mocked to `{}` above, so an unmocked repository call would throw
 * on `db.select` inside a `catch`-wrapped save and quietly change what this
 * suite observes. Stubbed at the module boundary, as the Mongoose model was.
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

vi.mock('../../../lib/prompt-loader.js', () => ({
  buildSystemPrompt: (...args: any[]) => mockBuildSystemPrompt(...args),
}));

vi.mock('../../../lib/token-counter.js', () => ({
  estimateMessageTokens: vi.fn(() => 100),
}));

vi.mock('../../../lib/tool-converter.js', () => ({
  convertOpenAIToolsToToolSet: vi.fn(() => ({})),
}));

vi.mock('../../../lib/tools/index.js', () => ({
  getCurrentDateTool: { execute: vi.fn() },
  webSearchTool: { execute: vi.fn() },
  browseTool: { execute: vi.fn() },
  saveUserMemoryTool: vi.fn(() => ({ execute: vi.fn() })),
  updateUserMemoryTool: vi.fn(() => ({ execute: vi.fn() })),
  updateUserPreferencesTool: vi.fn(() => ({ execute: vi.fn() })),
  updateUserContextTool: vi.fn(() => ({ execute: vi.fn() })),
  createSendTelegramTool: vi.fn(() => ({ execute: vi.fn() })),
  createGetWhatsAppChatsTool: vi.fn(() => ({ execute: vi.fn() })),
  createGetWhatsAppMessagesTool: vi.fn(() => ({ execute: vi.fn() })),
  createSendWhatsAppMessageTool: vi.fn(() => ({ execute: vi.fn() })),
  webScraperTool: { execute: vi.fn() },
  generateFileTool: { execute: vi.fn() },
  createSearchAgentsTool: vi.fn(() => ({ execute: vi.fn() })),
  createDelegateToAgentTool: vi.fn(() => ({ execute: vi.fn() })),
  createDeepResearchTool: vi.fn(() => ({ execute: vi.fn() })),
  createSwitchModelTool: vi.fn(() => ({ execute: vi.fn() })),
  createAgentTool: vi.fn(() => ({ execute: vi.fn() })),
  createPlanPreviewTool: vi.fn(() => ({ execute: vi.fn() })),
  createSuggestNewConversationTool: vi.fn(() => ({ execute: vi.fn() })),
}));

vi.mock('../../../middleware/api-key-rate-limit.js', () => ({
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/credit-anomaly.js', () => ({
  detectCreditAnomaly: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../lib/hooks/index.js', () => ({
  runBeforeChatHooks: vi.fn().mockResolvedValue({}),
  runAfterChatHooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/errors/index.js', () => ({
  toAliaError: vi.fn((_e: any) => ({
    code: 'INTERNAL_ERROR',
    userMessage: 'Something went wrong',
    retryable: true,
    retryAfter: 10,
    httpStatus: 500,
    reason: 'unknown',
    message: 'Something went wrong',
    name: 'AliaError',
  })),
  formatErrorResponse: vi.fn((e: any) => ({
    error: { code: e.code, message: e.userMessage, retryable: e.retryable },
  })),
  sanitizeMessage: vi.fn((msg: string) => msg),
  AliaError: class AliaError extends Error { code = ''; retryable = false; },
  AliaErrorCode: {},
  classifyError: vi.fn(() => 'unknown'),
  isAliaError: vi.fn(() => false),
  toSSEError: vi.fn((e: any) => ({ code: e.code, message: e.userMessage })),
  isTimeoutError: vi.fn(() => false),
  getRetryAfterHeader: vi.fn(() => undefined),
}));

vi.mock('../../../lib/gateway-client.js', () => ({
  getRoutingProfile: vi.fn(() => ({ name: 'Kaana V1', creditMultiplier: 1 })),
  getModelMappingsForTier: vi.fn(() => []),
}));

vi.mock('../../../lib/conversation-saver.js', () => ({
  saveConversation: vi.fn().mockResolvedValue(undefined),
  generateConversationTitle: vi.fn().mockResolvedValue('Test Conversation'),
  generateTitle: vi.fn().mockResolvedValue('Test Title'),
}));

vi.mock('../../../lib/plan-access.js', () => ({
  getUserEntitlements: vi.fn().mockResolvedValue({
    tier: 'free',
    features: {},
    allowedModelIds: ['kaana-v1', 'kaana-lite', 'kaana-v1-pro', 'kaana-v1-thinking'],
  }),
}));

vi.mock('../../../lib/tools/mcp.js', () => ({
  buildMcpTools: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../lib/tools/integrations.js', () => ({
  buildIntegrationTools: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../lib/tools/oxy-services.js', () => ({
  buildOxyServiceTools: vi.fn().mockResolvedValue({}),
  getOxyServicePromptFragment: vi.fn().mockReturnValue(''),
  getOxyServiceContext: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../../lib/tools/result-truncation.js', () => ({
  wrapToolsWithTruncation: vi.fn((tools: any) => tools),
  getToolResultBudget: vi.fn(() => 4000),
}));

vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      v1: child,
      chat: child,
      general: child,
      providers: child,
      correlation: child,
    },
  };
});

vi.mock('../../../lib/observability/index.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../../lib/research/research-engine.js', () => ({
  runDeepResearch: vi.fn(),
}));

vi.mock('../../../lib/autonomy/runtime.js', () => ({
  runAutonomyBeforeChat: vi.fn().mockResolvedValue(null),
  runAutonomyAfterChat: vi.fn().mockResolvedValue(undefined),
  buildAutonomyPromptFragment: vi.fn().mockResolvedValue(''),
}));

// ── Import router after mocks are set up ───────────────────────────────────

import chatCompletionsRouter from '../chat-completions.js';
import { FallbackNotPermittedError, UnregisteredModelError } from '../../../lib/routing/policy.js';

// ── Test constants ─────────────────────────────────────────────────────────

const VALID_RESOLVED_MODEL = {
  routingProfileId: 'kaana-v1',
  provider: 'openai',
  modelId: 'gpt-4o',
  keyConfig: { provider: 'openai', key: 'sk-test', modelId: 'gpt-4o', keyId: 'key-1' },
  routingProfile: { name: 'Kaana V1', creditMultiplier: 1 },
  isFallback: false,
  fallbackIndex: 0,
};

const VALID_RESERVATION = {
  userId: 'user-123',
  creditsReserved: 1,
  initialFreeCredits: 100,
  initialPaidCredits: 0,
};

// ── Helpers ────────────────────────────────────────────────────────────────

interface RouteStackLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ method?: string; handle: (req: unknown, res: unknown, next: unknown) => Promise<void> }>;
  };
}

function getHandler(): (req: any, res: any, next: any) => Promise<void> {
  const stack = (chatCompletionsRouter as unknown as { stack: RouteStackLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route?.path === '/' && layer.route?.methods?.post) {
      // The last handle in the route stack is the actual handler
      const handles = layer.route.stack.filter((s: any) => s.method === 'post');
      return handles[handles.length - 1].handle;
    }
  }
  throw new Error('POST / handler not found on router');
}

function createMockReq(overrides: Record<string, any> = {}) {
  return {
    user: { id: 'user-123' },
    apiKey: undefined,
    body: {
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'kaana-v1',
      stream: true,
    },
    headers: {},
    /**
     * An `IncomingMessage` is an EventEmitter and the provider loop registers a
     * `close` listener to notice a caller who walked away. This double had
     * neither method, so `req.on(...)` threw inside the per-attempt try — which
     * every assertion below silently tolerated, because the throw was
     * classified as a provider failure and the loop retried. Two of the cases
     * here were reading that accident as the behaviour they name.
     */
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

function createMockRes() {
  const written: string[] = [];
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let ended = false;
  let flushed = false;
  let _headersSent = false;

  const res: any = {
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    write: vi.fn((data: string) => {
      written.push(data);
      _headersSent = true;
      return true;
    }),
    end: vi.fn(() => { ended = true; }),
    flushHeaders: vi.fn(() => {
      flushed = true;
      _headersSent = true;
    }),
    status: vi.fn(function (this: any, code: number) {
      statusCode = code;
      return this;
    }),
    json: vi.fn((_data: any) => {
      _headersSent = true;
    }),
    on: vi.fn(),
    get headersSent() { return _headersSent; },
    socket: { setNoDelay: vi.fn() },
    // Test inspection helpers
    _written: written,
    _headers: headers,
    _statusCode: () => statusCode,
    _ended: () => ended,
    _flushed: () => flushed,
  };

  // Make status() chainable
  res.status.mockReturnThis();

  return res;
}

/** The SSE data frames a response wrote that are flagged `alia_meta.synthetic`. */
function syntheticChunks(res: any): Record<string, any>[] {
  return res.write.mock.calls
    .map((c: any[]) => String(c[0]))
    .filter((frame: string) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
    .map((frame: string) => {
      try {
        return JSON.parse(frame.slice(6).trim());
      } catch {
        return null;
      }
    })
    .filter((chunk: any) => chunk?.alia_meta?.synthetic === true);
}

function createMockStream(chunks: any[]) {
  return {
    fullStream: (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('504 timeout fixes - /v1/chat/completions', () => {
  let handler: (req: any, res: any, next: any) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    handler = getHandler();

    // Default happy-path mocks
    mockResolveModel.mockResolvedValue(VALID_RESOLVED_MODEL);
    mockReserveCredits.mockResolvedValue(VALID_RESERVATION);
    mockGetOrCreateUserCredits.mockResolvedValue({});
    mockGetUserById.mockResolvedValue(null);
    mockBuildSystemPrompt.mockResolvedValue('You are Alia.');
    mockStreamText.mockReturnValue(
      createMockStream([
        { type: 'text-delta', text: 'Hello' },
        { type: 'finish', finishReason: 'stop' },
      ])
    );
    mockGenerateText.mockResolvedValue({
      text: 'Hello',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      toolCalls: [],
      toolResults: [],
      finishReason: 'stop',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends early SSE headers + keep-alive before provider call (streaming)', async () => {
    const req = createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'kaana-v1', stream: true } });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // SSE headers were set
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');

    // Keep-alive comment was written
    expect(res.write).toHaveBeenCalledWith(': keep-alive\n\n');

    // flushHeaders was called
    expect(res.flushHeaders).toHaveBeenCalled();

    // Verify keep-alive was the FIRST write (before any data chunks)
    const firstWriteCall = res.write.mock.calls[0][0];
    expect(firstWriteCall).toBe(': keep-alive\n\n');

    // streamText was called (provider call happened after headers)
    expect(mockStreamText).toHaveBeenCalled();
  });

  it('does NOT send early SSE headers for non-streaming requests', async () => {
    const req = createMockReq({
      body: { messages: [{ role: 'user', content: 'Hi' }], model: 'kaana-v1', stream: false },
    });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // No keep-alive comment
    const keepAliveWrites = res.write.mock.calls.filter(
      (call: any[]) => call[0] === ': keep-alive\n\n'
    );
    expect(keepAliveWrites).toHaveLength(0);

    // flushHeaders NOT called (no early SSE)
    expect(res.flushHeaders).not.toHaveBeenCalled();

    // JSON response was sent
    expect(res.json).toHaveBeenCalled();
  });

  it('returns 402 JSON and clears timer when credits insufficient', async () => {
    mockReserveCredits.mockResolvedValue(null);

    const req = createMockReq({
      body: { messages: [{ role: 'user', content: 'Hello' }], model: 'kaana-v1', stream: false },
    });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // 402 with INSUFFICIENT_CREDITS
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INSUFFICIENT_CREDITS' }),
      })
    );

    // status called only once (global timer did not fire a second 503)
    expect(res.status).toHaveBeenCalledTimes(1);

    // streamText was NOT called (handler returned early)
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('returns 503 JSON and clears timer when no models available', async () => {
    mockResolveModel.mockResolvedValue(null);

    const req = createMockReq({
      body: { messages: [{ role: 'user', content: 'Hello' }], model: 'kaana-v1', stream: false },
    });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // 503 with "No models available"
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'No models available. Please try again.' }),
      })
    );

    // status called only once
    expect(res.status).toHaveBeenCalledTimes(1);

    // Provider call was NOT made
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('getUserById timeout does not block the handler', async () => {
    // getUserById never resolves — the Promise.race 5s timeout should resolve to null
    mockGetUserById.mockReturnValue(new Promise(() => {}));

    const req = createMockReq({ apiKey: undefined });
    const res = createMockRes();

    vi.useFakeTimers();

    const handlerPromise = handler(req, res, vi.fn());

    // Advance past the 5s getUserById timeout
    await vi.advanceTimersByTimeAsync(5100);

    // Let any pending microtasks and the stream processing settle
    await vi.advanceTimersByTimeAsync(100);

    await handlerPromise;

    // Handler completed (didn't hang waiting for getUserById)
    expect(res.write).toHaveBeenCalled();
    expect(mockStreamText).toHaveBeenCalled();
  });

  it('resolveModel .catch() prevents Promise.all crash', async () => {
    mockResolveModel.mockRejectedValue(new Error('Key manager DB error'));

    const req = createMockReq({
      body: { messages: [{ role: 'user', content: 'Hello' }], model: 'kaana-v1', stream: false },
    });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // Should get 503 (resolveModel returned null after catch)
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'No models available. Please try again.' }),
      })
    );

    // Handler completed normally (no unhandled rejection)
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it('sends SSE error chunk when all providers exhausted and headers already sent', async () => {
    // First resolve → valid model, streamText → throws retryable error
    // Second resolve (retry) → null (no more providers)
    let resolveCallCount = 0;
    mockResolveModel.mockImplementation(() => {
      resolveCallCount++;
      if (resolveCallCount === 1) return Promise.resolve(VALID_RESOLVED_MODEL);
      return Promise.resolve(null); // No more providers on retry
    });

    // streamText throws a retryable 429 error
    const retryableError = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    mockStreamText.mockImplementation(() => {
      return {
        // eslint-disable-next-line require-yield -- simulates immediate provider failure
        fullStream: (async function* () {
          throw retryableError;
        })(),
      };
    });

    const req = createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'kaana-v1', stream: true } });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // Early SSE keep-alive was sent
    expect(res.write).toHaveBeenCalledWith(': keep-alive\n\n');

    // SSE error chunk was sent (not a JSON 503)
    const allWrites = res.write.mock.calls.map((c: any[]) => c[0]).join('');
    expect(allWrites).toContain('all models are currently busy');
    expect(allWrites).toContain('data: [DONE]');

    // The stand-in message must be flagged: the app treats a turn whose only
    // content is synthetic as a failed send and hands the text back to the composer.
    expect(syntheticChunks(res)).toHaveLength(1);

    // res.end was called
    expect(res.end).toHaveBeenCalled();

    // res.status(503) was NOT called (headers already sent via SSE)
    expect(res.status).not.toHaveBeenCalledWith(503);
  });

  it('does not re-set SSE headers on subsequent chunks when earlySSE is active', async () => {
    const req = createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'kaana-v1', stream: true } });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // Content-Type: text/event-stream should be set exactly once (during early SSE)
    const contentTypeSetCalls = res.setHeader.mock.calls.filter(
      (call: any[]) => call[0] === 'Content-Type' && call[1] === 'text/event-stream'
    );
    expect(contentTypeSetCalls).toHaveLength(1);

    // The streaming data was still written correctly
    const dataWrites = res.write.mock.calls
      .map((c: any[]) => c[0])
      .filter((w: string) => w.startsWith('data: '));
    expect(dataWrites.length).toBeGreaterThan(0);
  });
});

// ── Routing policy on the request path (#139 ws14, ADR 0003) ───────────────

/**
 * The refusals as a CALLER sees them, driven through the real route handler and
 * the real `buildChatRequestContext`. Only `resolveModel` is replaced, at the
 * seam this file already owns — the discrimination under test (which refusal
 * becomes which status and which message) is the shipped code.
 *
 * The two controls that matter are already above and must keep passing:
 * "returns 503 JSON ... when no models available" and "resolveModel .catch()
 * prevents Promise.all crash". Together they say that a `null` resolution and a
 * generic rejection still produce the exact 503 they always did, so everything
 * below is an ADDITION rather than a change of behaviour.
 */
describe('a turn that produced nothing costs nothing - /v1/chat/completions', () => {
  let handler: (req: any, res: any, next: any) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    handler = getHandler();
    mockResolveModel.mockResolvedValue(VALID_RESOLVED_MODEL);
    mockReserveCredits.mockResolvedValue(VALID_RESERVATION);
    mockGetOrCreateUserCredits.mockResolvedValue({});
    mockGetUserById.mockResolvedValue(null);
    mockBuildSystemPrompt.mockResolvedValue('You are Alia.');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // `reserveCredits` DEBITS on the way in — a reservation that is never released
  // is a permanent charge, and `INITIAL_RESERVATION` is 1, so each of these
  // paths costs a person exactly one credit for an answer they never got.

  it('refunds when every provider is exhausted', async () => {
    // The control: this path already refunds, so a harness that could not see a
    // refund at all would fail here first and the cases below would prove nothing.
    let calls = 0;
    mockResolveModel.mockImplementation(() => {
      calls++;
      return Promise.resolve(calls === 1 ? VALID_RESOLVED_MODEL : null);
    });
    mockStreamText.mockImplementation(() => ({
      // eslint-disable-next-line require-yield -- simulates immediate provider failure
      fullStream: (async function* () {
        throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      })(),
    }));

    await handler(
      createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'kaana-v1', stream: true } }),
      createMockRes(),
      vi.fn(),
    );

    expect(mockRefundReservation).toHaveBeenCalledWith(VALID_RESERVATION);
  });

  it('refunds a stream that ended without producing any output', async () => {
    // The provider answered, cleanly, with nothing. `finalizeCredits` would bill
    // `MIN_CREDITS_PER_REQUEST` for zero tokens, which makes the adjustment zero
    // and quietly keeps the reservation as the charge.
    mockStreamText.mockReturnValue(createMockStream([{ type: 'finish', finishReason: 'stop' }]));

    await handler(
      createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'kaana-v1', stream: true } }),
      createMockRes(),
      vi.fn(),
    );

    expect(mockFinalizeCredits).not.toHaveBeenCalled();
    expect(mockRefundReservation).toHaveBeenCalledWith(VALID_RESERVATION);
  });

  it('refunds when the request runs past the global timeout', async () => {
    // The 80s guard answers with a stand-in and returns. Like the outer catch it
    // touches neither `finalizeCredits` nor `refundReservation`, so before the
    // release point existed the reservation simply stood.
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        await new Promise<void>((resolve) => { release = resolve; });
        yield { type: 'finish', finishReason: 'stop' };
      })(),
    }));

    const res = createMockRes();
    const pending = handler(
      createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'kaana-v1', stream: true } }),
      res,
      vi.fn(),
    );

    await vi.advanceTimersByTimeAsync(80_001);
    // Name the path: the timeout's own stand-in text, not the exhausted-providers
    // one, which already refunded and would satisfy the assertion below on its own.
    const written = res.write.mock.calls.map((c: any[]) => String(c[0])).join('');
    expect(written).toContain('Please send your message again.');

    release?.();
    await vi.runAllTimersAsync();
    await pending;

    expect(mockRefundReservation).toHaveBeenCalledWith(VALID_RESERVATION);
  });
});

describe('routing policy refusals - /v1/chat/completions', () => {
  let handler: (req: any, res: any, next: any) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    handler = getHandler();
    mockResolveModel.mockResolvedValue(VALID_RESOLVED_MODEL);
    mockReserveCredits.mockResolvedValue(VALID_RESERVATION);
    mockGetOrCreateUserCredits.mockResolvedValue({});
    mockGetUserById.mockResolvedValue(null);
    mockBuildSystemPrompt.mockResolvedValue('You are Alia.');
    mockStreamText.mockReturnValue(
      createMockStream([
        { type: 'text-delta', text: 'Hello' },
        { type: 'finish', finishReason: 'stop' },
      ])
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers an unregistered model with 400 and the product message, not 503', async () => {
    mockResolveModel.mockRejectedValue(new UnregisteredModelError('alia-flash', ['kaana-v1', 'kaana-lite']));

    const req = createMockReq({
      body: { messages: [{ role: 'user', content: 'Hello' }], model: 'alia-flash', stream: false },
    });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    // 503 is what this used to be, and what a generic failure still is. Naming
    // it here is what makes the discrimination the thing being measured.
    expect(res.status).not.toHaveBeenCalledWith(503);
    const [payload] = res.json.mock.calls[0];
    expect(payload.error.message).toContain('alia-flash');
    expect(payload.error.message).toContain('GET /catalogue');
    expect(payload.error.param).toBe('model');
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it('refuses a removed alias before reserving credits', async () => {
    mockResolveModel.mockRejectedValue(new UnregisteredModelError('alia-flash', ['kaana-v1']));

    await handler(
      createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'alia-flash', stream: false } }),
      createMockRes(),
      vi.fn(),
    );

    expect(mockReserveCredits).not.toHaveBeenCalled();
    expect(mockRefundReservation).not.toHaveBeenCalled();
  });

  it('answers an unavailable model under a restrictive policy with the policy message', async () => {
    mockResolveModel.mockRejectedValue(new FallbackNotPermittedError('kaana-v1', 'no-fallback'));

    const req = createMockReq({
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'kaana-v1',
        fallbackPolicy: 'no-fallback',
        stream: false,
      },
    });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    const [payload] = res.json.mock.calls[0];
    expect(payload.error.message).toContain('kaana-v1');
    // Distinguishable from the generic shortage, which is the whole point.
    expect(payload.error.message).not.toBe('No models available. Please try again.');
  });

  it('hands the caller’s policy to the resolver', async () => {
    const req = createMockReq({
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'kaana-v1',
        fallbackPolicy: 'same-model-only',
        stream: false,
      },
    });

    await handler(req, createMockRes(), vi.fn());

    expect(mockResolveModel).toHaveBeenCalledWith('kaana-v1', undefined, undefined, {
      fallbackPolicy: 'same-model-only',
    });
  });

  it('hands an EMPTY options object when the caller names no policy', async () => {
    // The byte-identical-default assertion, made positively. An absent
    // `fallbackPolicy` must not become an explicit one here — the engine's own
    // default is the single place that decision lives.
    const req = createMockReq({
      body: { messages: [{ role: 'user', content: 'Hello' }], model: 'kaana-v1', stream: false },
    });

    await handler(req, createMockRes(), vi.fn());

    expect(mockResolveModel).toHaveBeenCalledWith('kaana-v1', undefined, undefined, {});
  });

  it('resolves Kaana once with the caller policy and never retries in Alia', async () => {
    /**
     * Kaana owns provider selection, circuit breaking and retry policy. A
     * retryable stream failure must therefore end Alia's single attempt; a
     * second `resolveModel` call here would recreate provider rotation on the
     * product side and could widen the caller's policy.
     */
    mockResolveModel.mockResolvedValue(VALID_RESOLVED_MODEL);
    mockStreamText.mockImplementation(() => ({
      // eslint-disable-next-line require-yield -- simulates immediate provider failure
      fullStream: (async function* () {
        throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      })(),
    }));

    const req = createMockReq({
      body: {
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'kaana-v1',
        fallbackPolicy: 'no-fallback',
        stream: true,
      },
    });

    await handler(req, createMockRes(), vi.fn());

    expect(mockResolveModel).toHaveBeenCalledTimes(1);
    expect(mockResolveModel.mock.calls[0]?.[3]).toEqual({ fallbackPolicy: 'no-fallback' });
  });

  it('rejects a mistyped policy before reserving credits', async () => {
    const req = createMockReq({
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'kaana-v1',
        fallbackPolicy: 'no_fallback',
        stream: false,
      },
    });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    const [payload] = res.json.mock.calls[0];
    expect(payload.error.param).toBe('fallbackPolicy');
    expect(payload.error.message).toContain('no_fallback');
    // Nothing was reserved, so there is nothing to refund. A lenient parser
    // would instead have widened this to `cross-model` and billed the request.
    expect(mockReserveCredits).not.toHaveBeenCalled();
    expect(mockResolveModel).not.toHaveBeenCalled();
  });
});
