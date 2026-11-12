import { describe, expect, it, vi } from 'vitest';
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      v1: child,
      chat: child,
      general: child,
      agents: child,
      credits: child,
      providers: child,
    },
  };
});
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));
const { runChunks } = await import('./stream-harness.js');
const { createAgentReactionTurn } = await import('../reactions/agent-tool.js');

async function fixture() {
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
        reactionEntries: [{ emoji: '❤️', author: { kind: 'agent', id: 'a', name: 'Salina' } }],
        revision: 1,
        mutationId: 'op',
      }),
      publish: async () => undefined,
      complete,
    },
  );
  const args = { messageId: 'person', emoji: '❤️', active: true, finishTurn: true };
  const output = await turn.tool.execute!(args, { toolCallId: 'call', messages: [] });
  const chunks = [
    { type: 'tool-call', toolCallId: 'call', toolName: 'react_to_message', input: args },
    { type: 'tool-result', toolCallId: 'call', toolName: 'react_to_message', output },
  ];
  return { turn, complete, chunks };
}

describe('reaction-only completion on the real stream writer', () => {
  it('marks durable completion before authoritative success and a normal terminal, without synthesis text', async () => {
    const f = await fixture();
    const order: string[] = [];
    f.complete.mockImplementation(async () => {
      order.push('stored');
      return true;
    });
    const result = await runChunks(
      [...f.chunks, { type: 'finish', finishReason: 'tool-calls' }],
      undefined,
      undefined,
      {
        conversationReaction: f.turn,
        beforeReactionFinish: async () => {
          order.push('cancel-fence');
        },
        onReactionComplete: () => {
          order.push('marker');
        },
      },
    );
    expect(order).toEqual(['cancel-fence', 'stored', 'marker']);
    expect(result.reactionOnly).toBe(true);
    expect(result.assistantResponse).toBe('');
    expect(result.written.some((frame) => frame.includes('"finish_reason":"stop"'))).toBe(true);
  });

  it.each([
    { tail: [{ type: 'error', error: new Error('upstream failed') }] },
    {
      tail: [
        { type: 'finish', finishReason: 'tool-calls' },
        { type: 'error', error: new Error('late upstream failure') },
      ],
    },
    { tail: [] },
  ])(
    'does not convert a committed reaction plus incomplete/failed inference into success',
    async ({ tail }) => {
      const f = await fixture();
      const marker = vi.fn();
      await expect(
        runChunks([...f.chunks, ...tail], undefined, undefined, {
          conversationReaction: f.turn,
          onReactionComplete: marker,
        }),
      ).rejects.toThrow();
      expect(f.complete).not.toHaveBeenCalled();
      expect(marker).not.toHaveBeenCalled();
    },
  );

  it('keeps ordinary text plus a reaction as a normal answer', async () => {
    const f = await fixture();
    const result = await runChunks(
      [
        ...f.chunks,
        { type: 'text-delta', text: 'Here is the explanation.' },
        { type: 'finish', finishReason: 'stop' },
      ],
      undefined,
      undefined,
      { conversationReaction: f.turn },
    );
    expect(result.assistantResponse).toBe('Here is the explanation.');
    expect(result.reactionOnly).toBeUndefined();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it('refuses success when the clean-completion DB fence fails', async () => {
    const f = await fixture();
    f.complete.mockResolvedValue(false);
    const marker = vi.fn();
    await expect(
      runChunks(
        [...f.chunks, { type: 'finish', finishReason: 'tool-calls' }],
        undefined,
        undefined,
        { conversationReaction: f.turn, onReactionComplete: marker },
      ),
    ).rejects.toThrow('completion unavailable');
    expect(marker).not.toHaveBeenCalled();
  });

  it('a mixed unresolved tool cannot be hidden by a committed reaction', async () => {
    const f = await fixture();
    const marker = vi.fn();
    await expect(
      runChunks(
        [
          { type: 'tool-call', toolCallId: 'missing', toolName: 'lookup', input: {} },
          ...f.chunks,
          { type: 'finish', finishReason: 'tool-calls' },
        ],
        undefined,
        undefined,
        { conversationReaction: f.turn, onReactionComplete: marker },
      ),
    ).rejects.toThrow();
    expect(f.complete).not.toHaveBeenCalled();
    expect(marker).not.toHaveBeenCalled();
  });
});
