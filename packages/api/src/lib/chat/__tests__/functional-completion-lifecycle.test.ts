import { describe, expect, it, vi } from 'vitest';
import type { ProviderLoopParams } from '../provider-loop.js';

const H = vi.hoisted(() => ({ markers: 0 }));

vi.mock('ai', () => ({ streamText: vi.fn(() => ({})) }));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../db/chat/conversationRepository.js', () => ({ updateConversationTitle: vi.fn() }));
vi.mock('../../chat-lifecycle.js', () => ({
  saveConversationResult: vi.fn(async () => undefined),
  turnProducedOutput: vi.fn(() => false),
  startParallelTitleGeneration: vi.fn(),
  finalizeChatCredits: vi.fn(),
  runPostChatHooks: vi.fn(),
  notifyDisconnectedClient: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  log: {
    v1: {
      info: vi.fn((message: unknown) => {
        if (message === 'Alia functional turn completed') H.markers += 1;
      }),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../errors/index.js', () => ({ classifyError: vi.fn(), toAliaError: vi.fn() }));
vi.mock('../model-config.js', () => ({
  buildBaseConfig: vi.fn(() => ({ config: {}, clearFirstByteTimer: vi.fn() })),
}));
vi.mock('../non-streaming.js', () => ({ runNonStreaming: vi.fn() }));
vi.mock('../stream-runner.js', () => ({
  runStream: vi.fn(async () => ({
    assistantResponse: 'complete',
    toolInvocations: [],
    toolCallCount: 0,
    chunkCount: 1,
  })),
}));
vi.mock('../text-tool-fallback.js', () => ({
  runTextToolFallback: vi.fn(async ({ assistantResponse }: { assistantResponse: string }) => ({
    assistantResponse,
  })),
}));

import { runProviderLoop } from '../provider-loop.js';

describe('functional completion response lifecycle', () => {
  it('keeps the close listener through beforeStreamClose and emits no success for a late disconnect', async () => {
    H.markers = 0;
    const closeListeners = new Set<() => void>();
    const response = {
      writableEnded: false,
      on(event: string, listener: () => void) {
        if (event === 'close') closeListeners.add(listener);
      },
      off(event: string, listener: () => void) {
        if (event === 'close') closeListeners.delete(listener);
      },
      write: vi.fn(() => true),
      end() { response.writableEnded = true; },
    };
    const params = {
      req: { off: vi.fn() },
      res: response,
      sse: { startKeepAlive: vi.fn(), stopKeepAlive: vi.fn() },
      requestId: 'request-test',
      requestStartTime: Date.now(),
      globalTimer: setTimeout(() => undefined, 60_000),
      globalTimeoutMs: 120_000,
      state: {
        resolved: { routingProfileId: 'route:auto', modelId: 'model-test' },
        routingProfileId: 'route:auto',
        creditReservation: null,
        creditsSettled: true,
        globalTimedOut: false,
      },
      body: { stream: true },
      skills: { activated: () => [] },
      messages: [],
      conversationId: undefined,
      reasoningEffort: null,
      convertedMessages: [],
      truncatedTools: {},
      toolNameMapping: new Map(),
      agentMessages: [],
      systemPromptTokens: 0,
      requestedModel: 'route:auto',
      autonomyRuntime: null,
      includeUsage: false,
      beforeStreamClose: async () => {
        expect(closeListeners.size).toBeGreaterThan(0);
        for (const listener of closeListeners) listener();
      },
    } as unknown as ProviderLoopParams;

    const result = await runProviderLoop(params);

    expect(result.status).toBe('completed');
    expect(H.markers).toBe(0);
    expect(closeListeners.size).toBe(0);
    clearTimeout(params.globalTimer);
  });
});
