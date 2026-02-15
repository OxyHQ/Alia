import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared mock state ──────────────────────────────────────────────────────

const mockResolveModel = vi.fn();
const mockGetAIModel = vi.fn(() => 'mock-ai-model');
const mockReportModelUsage = vi.fn().mockResolvedValue(undefined);
const mockGetDefaultAliaModel = vi.fn(() => 'alia-v1');

const mockReserveCredits = vi.fn();
const mockFinalizeCredits = vi.fn().mockResolvedValue({ creditsCharged: 1, creditsRemaining: 99 });
const mockGetOrCreateUserCredits = vi.fn().mockResolvedValue({});

const mockStreamText = vi.fn();
const mockGenerateText = vi.fn();

const mockGetUserById = vi.fn().mockResolvedValue(null);

const mockBuildSystemPrompt = vi.fn().mockResolvedValue('You are Alia, a helpful AI assistant.');

// ── Module mocks ───────────────────────────────────────────────────────────

vi.mock('ai', () => ({
  streamText: (...args: any[]) => mockStreamText(...args),
  generateText: (...args: any[]) => mockGenerateText(...args),
  stepCountIs: vi.fn(() => 'mock-stop-condition'),
}));

vi.mock('../../../lib/chat-core.js', () => ({
  resolveModel: (...args: any[]) => mockResolveModel(...args),
  getAIModel: (...args: any[]) => mockGetAIModel(...args),
  getDefaultAliaModel: () => mockGetDefaultAliaModel(),
  reportModelUsage: (...args: any[]) => mockReportModelUsage(...args),
  isAliaModel: vi.fn(() => true),
  getAliaModel: vi.fn(() => ({ name: 'Alia V1', creditMultiplier: 1 })),
  getAllAliaModels: vi.fn(() => []),
  getAliaModelsByCategory: vi.fn(() => []),
  getDefaultModelForCategory: vi.fn(() => null),
  getAvailableModels: vi.fn(() => []),
  resolveAliaModelWithAttempts: vi.fn(),
}));

vi.mock('../../../internal/providers/lib/alia-models.js', () => ({
  getAliaModel: vi.fn(() => ({ name: 'Alia V1', creditMultiplier: 1 })),
  isAliaModel: vi.fn(() => true),
  getAllAliaModels: vi.fn(() => []),
  getAliaModelsByCategory: vi.fn(() => []),
  getDefaultModelForCategory: vi.fn(() => null),
  getAvailableModels: vi.fn(() => []),
}));

vi.mock('../../../lib/credits-manager.js', () => ({
  reserveCredits: (...args: any[]) => mockReserveCredits(...args),
  finalizeCredits: (...args: any[]) => mockFinalizeCredits(...args),
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

vi.mock('../../../models/user-memory.js', () => ({
  UserMemory: { findOne: vi.fn().mockResolvedValue(null) },
}));

vi.mock('../../../models/skill.js', () => ({
  Skill: {
    findOne: vi.fn(() => ({
      select: vi.fn(() => ({
        lean: vi.fn().mockResolvedValue(null),
      })),
    })),
  },
}));

vi.mock('../../../models/conversation.js', () => ({
  Conversation: { findOneAndUpdate: vi.fn().mockResolvedValue({}) },
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
  saveUserMemoryTool: vi.fn(() => ({ execute: vi.fn() })),
  updateUserPreferencesTool: vi.fn(() => ({ execute: vi.fn() })),
  updateUserContextTool: vi.fn(() => ({ execute: vi.fn() })),
  createSendTelegramTool: vi.fn(() => ({ execute: vi.fn() })),
  createGetWhatsAppChatsTool: vi.fn(() => ({ execute: vi.fn() })),
  createGetWhatsAppMessagesTool: vi.fn(() => ({ execute: vi.fn() })),
  createSendWhatsAppMessageTool: vi.fn(() => ({ execute: vi.fn() })),
  createProvidersAdminTool: vi.fn(() => ({ execute: vi.fn() })),
  webScraperTool: { execute: vi.fn() },
  generateFileTool: { execute: vi.fn() },
}));

vi.mock('../../../middleware/api-key-rate-limit.js', () => ({
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/credit-anomaly.js', () => ({
  detectCreditAnomaly: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../lib/hooks/index.js', () => ({
  runAfterChatHooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/error-handler.js', () => ({
  translateError: vi.fn((_e: any) => ({
    code: 'INTERNAL_ERROR',
    userMessage: 'Something went wrong',
    retryable: true,
    retryAfterSeconds: 10,
  })),
  formatErrorResponse: vi.fn((e: any) => ({
    error: { code: e.code, message: e.userMessage, retryable: e.retryable },
  })),
  sanitizeMessage: vi.fn((msg: string) => msg),
}));

// ── Import router after mocks are set up ───────────────────────────────────

import chatCompletionsRouter from '../chat-completions.js';

// ── Test constants ─────────────────────────────────────────────────────────

const VALID_RESOLVED_MODEL = {
  aliasModelId: 'alia-v1',
  provider: 'openai',
  modelId: 'gpt-4o',
  keyConfig: { provider: 'openai', key: 'sk-test', modelId: 'gpt-4o', keyId: 'key-1' },
  aliaModel: { name: 'Alia V1', creditMultiplier: 1 },
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

function getHandler(): (req: any, res: any, next: any) => Promise<void> {
  const stack = (chatCompletionsRouter as any).stack;
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
      model: 'alia-v1',
      stream: true,
    },
    headers: {},
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
    const req = createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'alia-v1', stream: true } });
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
      body: { messages: [{ role: 'user', content: 'Hi' }], model: 'alia-v1', stream: false },
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

    const req = createMockReq();
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

    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // 503 with "No models available"
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'No models available' })
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

    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // Should get 503 (resolveModel returned null after catch)
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'No models available' })
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
    const retryableError = new Error('Rate limit exceeded');
    (retryableError as any).status = 429;
    mockStreamText.mockImplementation(() => {
      return {
        fullStream: (async function* () {
          throw retryableError;
        })(),
      };
    });

    const req = createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'alia-v1', stream: true } });
    const res = createMockRes();

    await handler(req, res, vi.fn());

    // Early SSE keep-alive was sent
    expect(res.write).toHaveBeenCalledWith(': keep-alive\n\n');

    // SSE error chunk was sent (not a JSON 503)
    const allWrites = res.write.mock.calls.map((c: any[]) => c[0]).join('');
    expect(allWrites).toContain('All models are currently unavailable');
    expect(allWrites).toContain('data: [DONE]');

    // res.end was called
    expect(res.end).toHaveBeenCalled();

    // res.status(503) was NOT called (headers already sent via SSE)
    expect(res.status).not.toHaveBeenCalledWith(503);
  });

  it('does not re-set SSE headers on subsequent chunks when earlySSE is active', async () => {
    const req = createMockReq({ body: { messages: [{ role: 'user', content: 'Hi' }], model: 'alia-v1', stream: true } });
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
