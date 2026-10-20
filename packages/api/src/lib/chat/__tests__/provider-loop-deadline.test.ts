import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLoopParams } from '../provider-loop.js';

/**
 * What the provider loop does once the route's global timeout has answered the
 * client: it stores nothing and charges nothing (the route's release point
 * refunds), and it hands the provider the route's own abort controller.
 */

const H = vi.hoisted(() => ({
  runStream: vi.fn(),
  buildBaseConfig: vi.fn(),
}));

vi.mock('ai', () => ({ streamText: vi.fn(() => ({})) }));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../db/chat/conversationRepository.js', () => ({ updateConversationTitle: vi.fn() }));
vi.mock('../../chat-lifecycle.js', () => ({
  saveConversationResult: vi.fn(async () => undefined),
  turnProducedOutput: vi.fn(() => true),
  startParallelTitleGeneration: vi.fn(async () => null),
  finalizeChatCredits: vi.fn(async () => ({
    creditsCharged: 1,
    creditsRemaining: 9,
    creditWarning: null,
  })),
  runPostChatHooks: vi.fn(),
  notifyDisconnectedClient: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  log: { v1: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../errors/index.js', () => ({
  classifyError: vi.fn(() => 'timeout'),
  toAliaError: vi.fn((error: unknown) => error),
}));
vi.mock('../model-config.js', () => ({ buildBaseConfig: H.buildBaseConfig }));
vi.mock('../non-streaming.js', () => ({ runNonStreaming: vi.fn() }));
vi.mock('../stream-runner.js', () => ({ runStream: H.runStream }));
vi.mock('../text-tool-fallback.js', () => ({
  runTextToolFallback: vi.fn(async ({ assistantResponse }: { assistantResponse: string }) => ({
    assistantResponse,
  })),
}));

import { runProviderLoop } from '../provider-loop.js';
import {
  finalizeChatCredits,
  runPostChatHooks,
  saveConversationResult,
} from '../../chat-lifecycle.js';

function params(overrides: Partial<ProviderLoopParams> = {}) {
  const response = {
    writableEnded: false,
    on: vi.fn(),
    off: vi.fn(),
    write: vi.fn(() => true),
    end() {
      response.writableEnded = true;
    },
  };
  const state = {
    resolved: { modelId: 'acme/chat-1' },
    modelId: 'acme/chat-1',
    creditReservation: { userId: 'u' },
    creditsSettled: false,
    globalTimedOut: false,
  };
  const loopParams = {
    req: { off: vi.fn(), user: { id: 'user-1' } },
    res: response,
    sse: { startKeepAlive: vi.fn(), stopKeepAlive: vi.fn() },
    requestId: 'request-test',
    requestStartTime: Date.now(),
    globalTimer: setTimeout(() => undefined, 60_000),
    globalTimeoutMs: 120_000,
    state,
    body: { stream: true },
    skills: { activated: () => [] },
    messages: [{ role: 'user', content: 'hi' }],
    conversationId: 'c-1',
    reasoningEffort: null,
    convertedMessages: [],
    truncatedTools: {},
    toolNameMapping: new Map(),
    agentMessages: [],
    systemPromptTokens: 5,
    requestedModel: 'acme/chat-1',
    autonomyRuntime: null,
    includeUsage: false,
    ...overrides,
  } as unknown as ProviderLoopParams;
  return { loopParams, state };
}

const streamed = {
  assistantResponse: 'Hola',
  toolInvocations: [],
  toolCallCount: 0,
  chunkCount: 3,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 },
};

describe('the provider loop after the global timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.buildBaseConfig.mockReturnValue({
      config: {},
      clearFirstByteTimer: vi.fn(),
      watchdog: { touch: vi.fn(), toolStarted: vi.fn(), toolFinished: vi.fn(), stop: vi.fn() },
    });
  });

  it('stores nothing and charges nothing for an answer that finished after the timeout', async () => {
    const { loopParams, state } = params();
    H.runStream.mockImplementation(async () => {
      // The route's timer fires while the stream is still being read.
      state.globalTimedOut = true;
      return streamed;
    });

    const result = await runProviderLoop(loopParams).catch((error: unknown) => error);

    expect(vi.mocked(saveConversationResult)).not.toHaveBeenCalled();
    expect(vi.mocked(finalizeChatCredits)).not.toHaveBeenCalled();
    expect(state.creditsSettled).toBe(false);
    // Not a completed turn: it ends as the timeout, and the route refunds.
    expect(result).not.toMatchObject({ status: 'completed' });
    clearTimeout(loopParams.globalTimer);
  });

  it('gives the provider the abort controller the route owns, and stops the watchdog', async () => {
    const providerAbort = new AbortController();
    const { loopParams } = params({ providerAbort });
    H.runStream.mockResolvedValue(streamed);

    await runProviderLoop(loopParams);

    expect(H.buildBaseConfig).toHaveBeenCalledWith(expect.objectContaining({ providerAbort }));
    const { watchdog } = H.buildBaseConfig.mock.results[0].value;
    expect(watchdog.stop).toHaveBeenCalled();
    clearTimeout(loopParams.globalTimer);
  });

  it('bills the steps it saw when the SDK never reported the turn (tool-call limit)', async () => {
    const { loopParams } = params();
    H.runStream.mockResolvedValue({
      ...streamed,
      usage: { promptTokens: 150, completionTokens: 60, totalTokens: 210, reasoningTokens: 0 },
    });

    await runProviderLoop(loopParams);

    expect(vi.mocked(saveConversationResult)).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenUsage: expect.objectContaining({ totalTokens: 210, systemPromptTokens: 5 }),
      }),
      'Hola',
      [],
      [],
    );
    clearTimeout(loopParams.globalTimer);
  });

  it('marks an agent turn for the after-chat hooks', async () => {
    const { loopParams } = params({ agentTurn: true });
    H.runStream.mockResolvedValue(streamed);

    await runProviderLoop(loopParams);

    expect(vi.mocked(runPostChatHooks)).toHaveBeenCalledWith(
      expect.objectContaining({ agentTurn: true }),
      'Hola',
      expect.anything(),
      null,
    );
    clearTimeout(loopParams.globalTimer);
  });
});
