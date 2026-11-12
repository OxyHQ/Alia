import { describe, expect, it, vi } from 'vitest';
import type { ReactionEvent } from '../../../../db/chat/reactionRepository.js';
import type { HydratedAgent } from '../../../agent-identity.js';
import type { RoomEvent } from '../../room/bus.js';
import type { RoomEngineDeps, TranscriptRow } from '../../room/engine.js';
import { createLocalRoomLock } from '../../room/lock.js';
import { processReactionEvent, reactionReplyId, type ReactionEngineDeps } from '../engine.js';

const event = {
  id: 'reaction-1',
  userId: 'person',
  conversationId: 'room',
  messageId: 'answer',
  targetActorId: 'salina',
  emoji: '❤️',
  active: true,
  reactions: ['❤️'],
  revision: 1,
  responseEligible: true,
  surfaceApplicationId: null,
  decision: null,
  phase: 'select',
  createdAt: new Date(),
  leaseToken: 'lease',
  status: 'processing',
  attempts: 1,
} as ReactionEvent;
const actor = {
  _id: 'salina',
  name: 'Salina',
  handle: 'salina',
  color: null,
  character: null,
  description: 'Marketing',
} as unknown as HydratedAgent;
function setup() {
  const emitted: RoomEvent[] = [];
  const rows: TranscriptRow[] = [
    {
      id: 'question',
      clientMessageId: 'question',
      role: 'user',
      content: 'Ayúdame',
      agentId: null,
      agentName: null,
    },
    {
      id: 'answer-row',
      clientMessageId: 'answer',
      role: 'assistant',
      content: 'Podemos revisar la propuesta.',
      agentId: 'salina',
      agentName: 'Salina',
      reactions: ['❤️'],
    },
  ];
  const room = {
    lock: createLocalRoomLock(),
    now: Date.now,
    loadTranscript: vi.fn(async () => rows),
    repliesSince: vi.fn(async () => 0),
    publish: vi.fn(async (value: RoomEvent) => {
      emitted.push(value);
    }),
    select: vi.fn(async () => ({ action: 'idle', agentId: null, reason: 'complete' }) as const),
    runTurn: vi.fn(async () => ({
      response: '¿Qué parte te gustaría aclarar?',
      tokensUsed: 5,
      creditsCharged: 1,
    })),
    storeReply: vi.fn(async (input: { clientMessageId: string; content: string }) => {
      rows.push({
        id: 'stored',
        clientMessageId: input.clientMessageId,
        role: 'assistant',
        content: input.content,
        agentId: 'salina',
        agentName: 'Salina',
      });
      return { id: input.clientMessageId, seq: 2, createdAt: new Date() };
    }),
  } as unknown as RoomEngineDeps;
  const deps: ReactionEngineDeps = {
    room,
    owns: vi.fn(async () => true),
    space: vi.fn(async () => ({ name: 'Marketing', instructions: 'Keep feedback concise' })),
    commit: vi.fn(async (_, input) => ({
      ...(await room.storeReply(input)),
      content: input.content,
    })),
    current: vi.fn(async () => true),
    busy: vi.fn(async () => false),
    recipient: vi.fn(async () => actor),
    saveDecision: vi.fn(async () => true),
  };
  const speak = () =>
    vi
      .mocked(room.select!)
      .mockResolvedValue({ action: 'speak', agentId: 'salina', reason: 'contribution' });
  return { deps, room, emitted, rows, speak };
}

describe('reaction observation execution (selection is mocked, not a language evaluation)', () => {
  it('can deliberately stay quiet for a heart without thinking, speaking or writing a reply', async () => {
    const h = setup();
    expect(await processReactionEvent(event, h.deps)).toBe('completed');
    expect(h.room.runTurn).not.toHaveBeenCalled();
    expect(h.room.storeReply).not.toHaveBeenCalled();
    expect(h.emitted.map((e) => e.event)).toEqual(['group.idle']);
    expect(h.deps.saveDecision).toHaveBeenCalledWith(event, {
      action: 'idle',
      agentId: null,
      reason: 'complete',
    });
    expect(vi.mocked(h.room.select!).mock.calls[0]![0].trigger).toMatchObject({
      kind: 'reaction',
      emoji: '❤️',
      actorId: 'salina',
      senderId: 'person',
    });
  });
  it('persists selection before a single tool-free observation response, without synthesizing a user message', async () => {
    const h = setup();
    h.speak();
    expect(await processReactionEvent(event, h.deps)).toBe('completed');
    expect(h.deps.saveDecision).toHaveBeenCalledBefore(vi.mocked(h.room.runTurn));
    expect(h.room.runTurn).toHaveBeenCalledTimes(1);
    const input = vi.mocked(h.room.runTurn).mock.calls[0]![0];
    expect(input.task).toBe('');
    expect(input.observation?.content).toContain('Podemos revisar la propuesta.');
    expect(input.person.taskId).toBeUndefined();
    expect(input.observation?.instructions).toContain('no tools');
    expect(h.room.select).toHaveBeenCalledTimes(1);
    expect(h.room.storeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMessageId: reactionReplyId(event.id),
        agentInfo: expect.objectContaining({ id: 'salina' }),
      }),
    );
  });
  it('rejects a selector trying to wake a peer or hand off', async () => {
    for (const decision of [
      { action: 'speak', agentId: 'other', reason: 'contribution' },
      { action: 'speak', agentId: 'salina', reason: 'handoff' },
      { action: 'clarify', agentId: 'salina', reason: 'ambiguous' },
    ]) {
      const h = setup();
      vi.mocked(h.room.select!).mockResolvedValue(decision as never);
      expect(await processReactionEvent(event, h.deps)).toBe('failed');
      expect(h.room.runTurn).not.toHaveBeenCalled();
    }
  });
  it('never wakes a removed, replaced, unauthorized or superseded reaction', async () => {
    const h = setup();
    h.speak();
    vi.mocked(h.deps.current).mockResolvedValue(false);
    expect(await processReactionEvent(event, h.deps)).toBe('cancelled');
    expect(h.room.select).not.toHaveBeenCalled();
    expect(h.room.runTurn).not.toHaveBeenCalled();
  });
  it('waits while a substantive direct or group turn is active', async () => {
    const h = setup();
    vi.mocked(h.deps.busy).mockResolvedValue(true);
    expect(await processReactionEvent(event, h.deps)).toBe('deferred');
    expect(h.room.select).not.toHaveBeenCalled();
    expect(h.emitted).toEqual([]);
  });
  it('fails closed when admission cannot be checked', async () => {
    const h = setup();
    vi.mocked(h.deps.busy).mockRejectedValue(new Error('database unavailable'));
    await expect(processReactionEvent(event, h.deps)).rejects.toThrow('database unavailable');
    expect(h.room.select).not.toHaveBeenCalled();
    expect(h.room.runTurn).not.toHaveBeenCalled();
  });
  it('rechecks retraction after selection before actor activity', async () => {
    const h = setup();
    vi.mocked(h.room.select!).mockImplementation(async () => {
      vi.mocked(h.deps.current).mockResolvedValue(false);
      return { action: 'speak', agentId: 'salina', reason: 'contribution' };
    });
    expect(await processReactionEvent(event, h.deps)).toBe('cancelled');
    expect(h.room.runTurn).not.toHaveBeenCalled();
    expect(h.emitted.some((e) => e.event === 'alia.agent_start')).toBe(false);
  });
  it('discards a response if the person retracts or sends while generation is running', async () => {
    const h = setup();
    h.speak();
    vi.mocked(h.room.runTurn).mockImplementation(async () => {
      vi.mocked(h.deps.current).mockResolvedValue(false);
      return { response: 'obsolete', tokensUsed: 5, creditsCharged: 1 };
    });
    expect(await processReactionEvent(event, h.deps)).toBe('cancelled');
    expect(h.room.storeReply).not.toHaveBeenCalled();
    expect(h.emitted.find((e) => e.event === 'alia.agent_end')?.data.status).toBe('declined');
  });
  it('replays the durable reply with the same identity after a lost completion', async () => {
    const h = setup();
    h.speak();
    await processReactionEvent(event, h.deps);
    await processReactionEvent(
      { ...event, decision: { action: 'speak', agentId: 'salina', reason: 'contribution' } },
      h.deps,
    );
    expect(h.room.runTurn).toHaveBeenCalledTimes(1);
    expect(h.room.storeReply).toHaveBeenCalledTimes(1);
    const messages = h.emitted.filter((e) => e.event === 'group.message');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.data.message).toMatchObject({ id: reactionReplyId(event.id) });
    expect(messages[1]!.data.message).toMatchObject({ id: reactionReplyId(event.id) });
  });
  it('uses the persisted selection on a speaking retry', async () => {
    const h = setup();
    await processReactionEvent(
      {
        ...event,
        phase: 'speak',
        decision: { action: 'speak', agentId: 'salina', reason: 'contribution' },
      },
      h.deps,
    );
    expect(h.room.select).not.toHaveBeenCalled();
    expect(h.deps.saveDecision).not.toHaveBeenCalled();
    expect(h.room.runTurn).toHaveBeenCalledTimes(1);
  });
  it('replays a committed reply even if newer feedback superseded the event before publication', async () => {
    const h = setup();
    h.speak();
    await processReactionEvent(event, h.deps);
    vi.mocked(h.deps.current).mockResolvedValue(false);
    vi.mocked(h.deps.recipient).mockResolvedValue(null);
    expect(await processReactionEvent(event, h.deps)).toBe('completed');
    expect(h.room.runTurn).toHaveBeenCalledTimes(1);
    expect(h.emitted.filter((e) => e.event === 'group.message')).toHaveLength(2);
  });
  it('a final atomic commit refusal cannot publish obsolete output', async () => {
    const h = setup();
    h.speak();
    vi.mocked(h.deps.commit).mockResolvedValue(null);
    expect(await processReactionEvent(event, h.deps)).toBe('cancelled');
    expect(h.room.storeReply).not.toHaveBeenCalled();
    expect(h.emitted.some((e) => e.event === 'group.message')).toBe(false);
    expect(h.emitted.find((e) => e.event === 'alia.agent_end')?.data.status).toBe('declined');
  });
  it('gives selection the current space brief', async () => {
    const h = setup();
    await processReactionEvent(event, h.deps);
    expect(vi.mocked(h.room.select!).mock.calls[0]?.[0].space).toEqual({
      name: 'Marketing',
      instructions: 'Keep feedback concise',
    });
  });
  it('aborts a reaction within one polling interval when substantive work arrives, releasing the room lock', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      h.speak();
      vi.mocked(h.room.runTurn).mockImplementation(
        (input) =>
          new Promise((_, reject) => {
            input.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true,
            });
          }),
      );
      const work = processReactionEvent(event, h.deps);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.room.runTurn).toHaveBeenCalledTimes(1);
      vi.mocked(h.deps.busy).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await work).toBe('cancelled');
      expect(h.room.storeReply).not.toHaveBeenCalled();
      expect(await h.room.lock.run('person:room', async () => 'new turn acquired')).toBe(
        'new turn acquired',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
