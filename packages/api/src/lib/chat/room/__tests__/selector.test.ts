import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generate: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  refund: vi.fn(),
  model: vi.fn(),
}));
vi.mock('ai', () => ({ generateObject: h.generate }));
vi.mock('../../../chat-core.js', () => ({
  resolveUtilityModel: async () => ({ modelId: 'instant' }),
  getAIModel: h.model,
  utilityOutputTokens: (n: number) => n + 2048,
}));
vi.mock('../../../product-credit-access.js', () => ({
  reserveBackgroundProductCredits: h.reserve,
}));
vi.mock('../../../credits-manager.js', () => ({
  finalizeCredits: h.settle,
  refundReservation: h.refund,
}));
vi.mock('../../../models/power-levels.js', () => ({
  servedModelId: () => 'served/model',
  servedReferenceOf: () => 'served/model',
}));
vi.mock('../../../logger.js', () => ({ log: { agents: { info: vi.fn() } } }));
const { selectRoomDecision } = await import('../selector.js');
const input = {
  userId: 'u',
  conversationId: 'room',
  triggerId: 'p',
  lastSpeakerId: null,
  depth: 0,
  roster: [{ info: { id: 'e', name: 'Eusebio', handle: 'eusebio', color: null, character: null } }],
  rows: [
    {
      id: 'p',
      clientMessageId: 'p',
      role: 'user',
      content: 'Eusebio, ¿qué puedes hacer?',
      agentName: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.reserve.mockResolvedValue({ id: 'reservation' });
  h.settle.mockResolvedValue({ creditsCharged: 1 });
  h.generate.mockResolvedValue({
    object: { action: 'speak', agentId: 'e', reason: 'directed' },
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
  });
});

describe('room selection inference accounting', () => {
  it('uses bounded structured inference with no tools and settles actual served-model usage', async () => {
    expect((await selectRoomDecision(input)).agentId).toBe('e');
    const call = h.generate.mock.calls[0]?.[0];
    expect(call.tools).toBeUndefined();
    expect(call.maxOutputTokens).toBe(2560);
    expect(call.maxRetries).toBe(1);
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(call.prompt).messages[0].content).toBe(input.rows[0]?.content);
    expect(h.settle).toHaveBeenCalledWith(
      { id: 'reservation' },
      { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
      'served/model',
    );
    expect(h.refund).not.toHaveBeenCalled();
  });

  it('does not infer without credits', async () => {
    h.reserve.mockResolvedValue(null);
    await expect(selectRoomDecision(input)).rejects.toThrow('credits');
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('refunds failed inference and never guesses a speaker', async () => {
    h.generate.mockRejectedValue(new Error('timeout'));
    await expect(selectRoomDecision(input)).rejects.toThrow('timeout');
    expect(h.refund).toHaveBeenCalledWith({ id: 'reservation' });
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('settles a completed generation even if its selected ID is invalid', async () => {
    h.generate.mockResolvedValue({
      object: { action: 'speak', agentId: 'outsider', reason: 'directed' },
      usage: {},
    });
    await expect(selectRoomDecision(input)).rejects.toThrow('non-member');
    expect(h.settle).toHaveBeenCalledOnce();
    expect(h.refund).not.toHaveBeenCalled();
  });
});
