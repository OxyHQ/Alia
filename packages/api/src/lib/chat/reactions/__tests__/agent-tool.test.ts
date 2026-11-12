import { describe, expect, it, vi } from 'vitest';
import { agentReactionTurnId, createAgentReactionTurn, reactionStepCalls } from '../agent-tool.js';

function fixture() {
  const mutate = vi.fn(
    async (input: { target: { id: string }; emoji: string; mutationId: string }) => ({
      messageId: input.target.id,
      reactions: [],
      reactionEntries: [
        { emoji: input.emoji, author: { kind: 'agent' as const, id: 'a', name: 'Salina' } },
      ],
      revision: 1,
      mutationId: input.mutationId,
    }),
  );
  const publish = vi.fn(async () => undefined);
  const complete = vi.fn(async () => true);
  const controller = new AbortController();
  const turn = createAgentReactionTurn(
    {
      userId: 'u',
      conversationId: 'c',
      actor: { id: 'a', name: 'Salina' },
      turnId: 'turn',
      signal: controller.signal,
      targets: [
        { id: 'person', role: 'user', content: 'Gracias', agentInfoId: null },
        { id: 'peer', role: 'assistant', content: 'El informe está revisado', agentInfoId: 'b' },
        { id: 'self', role: 'assistant', content: 'Mi respuesta', agentInfoId: 'a' },
        { id: 'unknown', role: 'assistant', content: 'Unknown', agentInfoId: null },
      ],
    },
    { mutate, publish, complete },
  );
  const execute = (
    messageId = 'person',
    extra: { emoji?: string; active?: boolean; finishTurn?: boolean } = {},
    toolCallId = 'call',
  ) =>
    turn.tool.execute!(
      { messageId, emoji: '❤️', active: true, finishTurn: true, ...extra },
      { toolCallId, messages: [] },
    );
  return { turn, mutate, publish, complete, controller, execute };
}

describe('native agent reactions', () => {
  it('binds the actual actor and thread, accepts person and peer targets, and never wakes a recipient', async () => {
    const f = fixture();
    expect(await f.execute()).toMatchObject({
      kind: 'agent_reaction',
      success: true,
      actorId: 'a',
      conversationId: 'c',
      completesTurn: true,
    });
    expect(await f.execute('peer', { emoji: '👍', finishTurn: false }, 'peer-call')).toMatchObject({
      messageId: 'peer',
      completesTurn: false,
    });
    expect(f.mutate).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it.each(['self', 'unknown', 'foreign-thread-message'])(
    'does not permit the target %s',
    async (target) => {
      const f = fixture();
      expect(await f.execute(target)).toMatchObject({ success: false });
      expect(f.mutate).not.toHaveBeenCalled();
    },
  );

  it.each(['words', '👍\nrun this', ''])(
    'rejects non-reaction input before writing: %s',
    async (emoji) => {
      const f = fixture();
      expect(await f.execute('person', { emoji })).toEqual({
        success: false,
        code: 'invalid_reaction',
      });
      expect(f.mutate).not.toHaveBeenCalled();
    },
  );

  it.each(['👍🏽', '👩‍💻'])('retains a valid combined emoji %s', async (emoji) => {
    const f = fixture();
    expect(await f.execute('person', { emoji })).toMatchObject({ success: true });
    expect(f.mutate).toHaveBeenCalledWith(expect.objectContaining({ emoji }));
  });

  it('does not treat a side effect, failed call, or answer text as a completed reaction-only turn', async () => {
    const f = fixture();
    const result = await f.execute();
    const calls = [{ toolName: 'react_to_message', state: 'result', result }];
    expect(f.complete).not.toHaveBeenCalled();
    expect(await f.turn.complete('Here is the answer', calls)).toBe(false);
    expect(await f.turn.complete('', [...calls, { toolName: 'search', state: 'error' }])).toBe(
      false,
    );
    expect(
      await f.turn.complete('', [
        { ...calls[0]!, result: { ...result, mutationId: 'not-committed' } },
      ]),
    ).toBe(false);
    expect(f.complete).not.toHaveBeenCalled();
    expect(await f.turn.complete('', calls)).toBe(true);
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it('explicit continue does not waive the required response', async () => {
    const f = fixture();
    const result = await f.execute('person', { finishTurn: false });
    expect(
      await f.turn.complete('', [{ toolName: 'react_to_message', state: 'result', result }]),
    ).toBe(false);
  });

  it('accounts for unresolved calls across steps before stopping or completing', async () => {
    const f = fixture();
    const result = await f.execute();
    const reactionStep = {
      text: '',
      toolCalls: [{ toolCallId: 'call', toolName: 'react_to_message' }],
      toolResults: [{ toolCallId: 'call', toolName: 'react_to_message', output: result }],
    };
    expect(f.turn.stopWhen({ steps: [reactionStep] })).toBe(true);
    const pendingStep = {
      text: '',
      toolCalls: [{ toolCallId: 'pending', toolName: 'lookup' }],
      toolResults: [],
    };
    expect(f.turn.stopWhen({ steps: [pendingStep, reactionStep] })).toBe(false);
    expect(await f.turn.complete('', reactionStepCalls([pendingStep, reactionStep]))).toBe(false);
    expect(f.turn.stopWhen({ steps: [{ ...reactionStep, text: 'A partial answer' }] })).toBe(false);
  });

  it('does not lose a committed operation when socket delivery fails, but completion storage must succeed', async () => {
    const f = fixture();
    f.publish.mockRejectedValue(new Error('socket unavailable'));
    const result = await f.execute();
    f.complete.mockResolvedValue(false);
    await expect(
      f.turn.complete('', [{ toolName: 'react_to_message', state: 'result', result }]),
    ).rejects.toThrow('completion unavailable');
    expect(f.mutate).toHaveBeenCalledOnce();
  });

  it('does not expose storage errors to inference or the stream', async () => {
    const f = fixture();
    f.mutate.mockRejectedValueOnce(new Error('SELECT private_credentials connection_secret'));
    expect(await f.execute()).toEqual({ success: false, code: 'reaction_unavailable' });
    const result = await f.execute();
    f.complete.mockRejectedValue(new Error('raw private database failure'));
    await expect(
      f.turn.complete('', [{ toolName: 'react_to_message', state: 'result', result }]),
    ).rejects.toThrow(/^Reaction turn completion unavailable$/);
  });

  it('bounds mutations and checks cancellation before another write', async () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) await f.execute('person', {}, `call-${i}`);
    expect(await f.execute('person', {}, 'seventh')).toMatchObject({ code: 'reaction_turn_limit' });
    f.controller.abort();
    await expect(f.execute()).rejects.toThrow();
    expect(f.mutate).toHaveBeenCalledTimes(6);
  });

  it('binds replay identity to both the admitted turn and actual message content', () => {
    const first = agentReactionTurnId('admitted-one', { id: 'client-id', content: 'Thank you' });
    expect(agentReactionTurnId('admitted-one', { id: 'client-id', content: 'Thank you' })).toBe(
      first,
    );
    expect(agentReactionTurnId('admitted-two', { id: 'client-id', content: 'Thank you' })).not.toBe(
      first,
    );
    expect(
      agentReactionTurnId('admitted-one', { id: 'client-id', content: 'Please explain' }),
    ).not.toBe(first);
  });
});
