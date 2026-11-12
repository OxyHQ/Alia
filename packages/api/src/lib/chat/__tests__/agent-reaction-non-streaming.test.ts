import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ generate: vi.fn(), save: vi.fn(), settle: vi.fn() }));
vi.mock('ai', async (original) => ({
  ...(await original<typeof import('ai')>()),
  generateText: h.generate,
}));
vi.mock('../../chat-lifecycle.js', () => ({
  saveConversationResult: h.save,
  turnProducedOutput: (text: string, calls: unknown[] = []) => !!text || calls.length > 0,
  generateTitleAsync: vi.fn(),
  finalizeChatCredits: h.settle,
  runPostChatHooks: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  log: { v1: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
const { runNonStreaming } = await import('../non-streaming.js');
const { createAgentReactionTurn } = await import('../reactions/agent-tool.js');

beforeEach(() => {
  vi.clearAllMocks();
  h.settle.mockResolvedValue({ creditsCharged: 1, creditsRemaining: 10, creditWarning: null });
});

async function fixture(finishTurn = true) {
  const complete = vi.fn(async () => true);
  const turn = createAgentReactionTurn(
    {
      userId: 'u',
      conversationId: 'c',
      actor: { id: 'a', name: 'Salina' },
      turnId: 'turn',
      targets: [{ id: 'person', role: 'user', content: 'Gracias', agentInfoId: null }],
    },
    {
      mutate: async () => ({
        messageId: 'person',
        reactions: [],
        reactionEntries: [],
        revision: 1,
        mutationId: 'op',
      }),
      publish: async () => undefined,
      complete,
    },
  );
  const input = { messageId: 'person', emoji: '❤️', active: true, finishTurn };
  const output = await turn.tool.execute!(input, { toolCallId: 'call', messages: [] });
  const toolCalls = [{ toolCallId: 'call', toolName: 'react_to_message', input }];
  const toolResults = [{ toolCallId: 'call', toolName: 'react_to_message', output }];
  const result = {
    text: '',
    finishReason: 'tool-calls',
    toolCalls,
    toolResults,
    steps: [{ text: '', toolCalls, toolResults }],
    totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    response: { messages: [] },
  };
  const json = vi.fn();
  const params = {
    req: { user: { id: 'u' } },
    res: { json, headersSent: false, writableEnded: false },
    requestId: 'req',
    globalTimer: setTimeout(() => undefined, 60_000),
    baseConfig: { messages: [] },
    clearFirstByteTimer: vi.fn(),
    modelId: 'test/model',
    requestedModel: 'instant',
    reasoningEffort: null,
    conversationId: 'c',
    assistantMessageId: 'reply',
    messages: [{ role: 'user', content: 'Gracias' }],
    creditReservation: null,
    systemPromptTokens: 0,
    requestStartTime: Date.now(),
    skills: { activated: () => [] },
    autonomyRuntime: null,
    toolNameMapping: new Map(),
    observation: { cancelled: false, timeToFirstTokenMs: null, resolvedModelReference: null },
    settlement: { creditsSettled: false },
    conversationReaction: turn,
  } as unknown as Parameters<typeof runNonStreaming>[0];
  return { complete, result, params, json };
}

describe('non-streaming native reaction completion', () => {
  it('returns authoritative metadata and does not rewrite admitted history or create an empty assistant row', async () => {
    const f = await fixture();
    h.generate.mockResolvedValue(f.result);
    await runNonStreaming(f.params);
    expect(h.generate).toHaveBeenCalledOnce();
    expect(f.complete).toHaveBeenCalledOnce();
    expect(h.save).not.toHaveBeenCalled();
    expect(f.json).toHaveBeenCalledWith(
      expect.objectContaining({
        alia_meta: {
          reactionOnly: true,
          conversationStored: true,
          conversationId: 'c',
          agentId: 'a',
        },
      }),
    );
    clearTimeout(f.params.globalTimer);
  });

  it('a continue reaction followed by an empty synthesis is a real empty-response failure', async () => {
    const f = await fixture(false);
    h.generate.mockResolvedValueOnce(f.result).mockResolvedValueOnce({
      ...f.result,
      text: '',
      finishReason: 'stop',
      toolCalls: [],
      toolResults: [],
      steps: [],
    });
    try {
      await expect(runNonStreaming(f.params)).rejects.toThrow();
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.json).not.toHaveBeenCalled();
      expect(h.save).not.toHaveBeenCalled();
    } finally {
      clearTimeout(f.params.globalTimer);
    }
  });

  it('keeps a normal text answer alongside a reaction', async () => {
    const f = await fixture(false);
    h.generate.mockResolvedValueOnce({
      ...f.result,
      text: 'La explicación es esta.',
      finishReason: 'stop',
      steps: [
        ...f.result.steps,
        { text: 'La explicación es esta.', toolCalls: [], toolResults: [] },
      ],
    });
    await runNonStreaming(f.params);
    expect(f.complete).not.toHaveBeenCalled();
    expect(h.save).toHaveBeenCalledWith(
      expect.anything(),
      'La explicación es esta.',
      expect.any(Array),
    );
    expect(f.json.mock.calls[0]?.[0]).not.toHaveProperty('alia_meta');
    clearTimeout(f.params.globalTimer);
  });
});
