import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generate: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  refund: vi.fn(),
  model: vi.fn(),
  info: vi.fn(),
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
vi.mock('../../../logger.js', () => ({ log: { agents: { info: h.info } } }));
const { selectRoomDecision } = await import('../selector.js');
const { ROOM_SELECTION_SYSTEM, REACTION_SELECTION_SYSTEM } = await import('../decision.js');
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
    object: {
      choice: 'person-request:e',
    },
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
    expect(call.system).toBe(ROOM_SELECTION_SYSTEM);
    expect(
      call.schema.parse({
        choice: 'clarify-person-request:e',
      }),
    ).toEqual({ choice: 'clarify-person-request:e' });
    expect(Object.keys(call.schema.shape)).toEqual(['choice']);
    expect(JSON.parse(call.prompt).allowedChoices).toContainEqual({
      id: 'person-request:e',
      action: 'speak',
      agentId: 'e',
      source: { messageId: 'p', role: 'user', actorId: null },
    });
    expect(JSON.parse(call.prompt).personRequest.content).toBe(input.rows[0]?.content);
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

  it('uses only the authoritative source choice and discards unsolicited explanatory output', async () => {
    const assessment = 'Transient description of pending work; never stored or logged.';
    h.generate.mockResolvedValue({ object: { assessment, choice: 'person-request:e' }, usage: {} });
    const decision = await selectRoomDecision(input);
    expect(decision).toEqual({ action: 'speak', agentId: 'e', reason: 'directed' });
    expect(JSON.stringify(h.info.mock.calls)).not.toContain(assessment);
    expect(JSON.stringify(h.settle.mock.calls)).not.toContain(assessment);
  });

  it('refunds failed inference and never guesses a speaker', async () => {
    h.generate.mockRejectedValue(new Error('timeout'));
    await expect(selectRoomDecision(input)).rejects.toThrow('timeout');
    expect(h.refund).toHaveBeenCalledWith({ id: 'reservation' });
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('settles a completed generation even if its selected ID is invalid', async () => {
    h.generate.mockResolvedValue({
      object: { choice: 'person-request:outsider' },
      usage: {},
    });
    await expect(selectRoomDecision(input)).rejects.toThrow();
    expect(h.settle).toHaveBeenCalledOnce();
    expect(h.refund).not.toHaveBeenCalled();
  });

  it('rejects the observed clarify/directed contradiction rather than repairing its recipient', async () => {
    h.generate.mockResolvedValue({
      object: { action: 'clarify', agentId: 'e', reason: 'directed' },
      usage: {},
    });
    await expect(selectRoomDecision(input)).rejects.toThrow();
    const schema = h.generate.mock.calls[0]?.[0].schema;
    expect(schema.safeParse({ action: 'clarify', agentId: 'e', reason: 'directed' }).success).toBe(
      false,
    );
    expect(h.settle).toHaveBeenCalledOnce();
    expect(h.refund).not.toHaveBeenCalled();
  });
});

describe('reaction selection generation contract', () => {
  const reaction = {
    ...input,
    triggerId: 'reaction-event',
    trigger: {
      kind: 'reaction' as const,
      eventId: 'reaction-event',
      messageId: 'answer',
      actorId: 'e',
      senderId: 'u',
      emoji: '❓',
      reactions: ['❓'],
    },
    rows: [
      ...input.rows,
      {
        id: 'db-answer',
        clientMessageId: 'answer',
        role: 'assistant',
        content: 'An explanation that can be clarified.',
        agentName: 'Eusebio',
        agentId: 'e',
      },
    ],
  };

  it.each([
    { action: 'speak', agentId: 'e', reason: 'contribution' },
    { action: 'idle', agentId: null, reason: 'complete' },
  ])('maps the sole inference choice $action to its exact validated outcome', async (expected) => {
    // This tests the generation contract and authority boundary, not model semantics.
    h.generate.mockResolvedValue({ object: { action: expected.action }, usage: {} });
    expect(await selectRoomDecision(reaction)).toEqual(expected);
    const call = h.generate.mock.calls[0]?.[0];
    expect(call.system).toBe(REACTION_SELECTION_SYSTEM);
    expect(call.schema.parse({ action: expected.action })).toEqual({ action: expected.action });
    for (const action of ['clarify', 'unavailable', 'invalid'])
      expect(call.schema.safeParse({ action }).success).toBe(false);
    expect(Object.keys(call.schema.shape)).toEqual(['action']);
    const data = JSON.parse(call.prompt);
    expect(
      data.messages.find((row: { id: string }) => row.id === data.trigger.messageId).content,
    ).toBe(reaction.rows[1]?.content);
    expect(data).not.toHaveProperty('clarificationSpeakerId');
    expect(data).not.toHaveProperty('remainingHandoffs');
    expect(h.settle).toHaveBeenCalledOnce();
    expect(h.refund).not.toHaveBeenCalled();
  });

  it('never lets model-supplied identity or reason widen the reaction recipient', async () => {
    h.generate.mockResolvedValue({
      object: { action: 'speak', agentId: 'outsider', reason: 'handoff' },
      usage: {},
    });
    expect(await selectRoomDecision(reaction)).toEqual({
      action: 'speak',
      agentId: 'e',
      reason: 'contribution',
    });
    await expect(selectRoomDecision({ ...reaction, roster: [] })).rejects.toThrow('non-member');
  });

  it('retains semantic validation when the fixed recipient is unavailable', async () => {
    h.generate.mockResolvedValue({ object: { action: 'speak' }, usage: {} });
    await expect(
      selectRoomDecision({
        ...reaction,
        roster: reaction.roster.map((member) => ({ ...member, available: false })),
      }),
    ).rejects.toThrow('unavailable');
    expect(h.settle).toHaveBeenCalledOnce();
    expect(h.refund).not.toHaveBeenCalled();
  });
});
