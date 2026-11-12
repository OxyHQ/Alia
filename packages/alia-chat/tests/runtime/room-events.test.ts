import { describe, expect, it } from 'vitest';
import {
  applyRoomEvent,
  claimConsult,
  createRoomLedger,
  isRoomOwned,
  releaseConsult,
  type RoomEvent,
} from '../../src/runtime/room-events';
import type { Message } from '../../src/runtime/types';

/**
 * A group conversation is a room (ADR 0025): its members' events fold into the thread's messages,
 * as the same agent messages the request's SSE frames draw.
 */

const CONV = 'c1';
const NADIA = { id: 'nadia', name: 'Nadia', handle: 'nadia', color: 'teal' };
const event = (name: string, data: Record<string, unknown>, conversationId = CONV): RoomEvent => ({
  conversationId,
  chainId: 'p1',
  event: name,
  data,
});
const start = (consultId = 'k1') =>
  event('alia.agent_start', { consultId, agent: NADIA, task: 'x' });
const delta = (content: string, consultId = 'k1') =>
  event('alia.agent_delta', { consultId, content });
const end = (data: Record<string, unknown>, consultId = 'k1') =>
  event('alia.agent_end', { consultId, ...data });
const reply = (id: string, content: string) =>
  event('group.message', {
    message: {
      id,
      role: 'assistant',
      agentInfo: NADIA,
      content,
      seq: 3,
      createdAt: '2026-11-09T10:00:00.000Z',
    },
  });

function run(events: RoomEvent[], from: Message[] = [], ledger = createRoomLedger()) {
  let messages = from;
  for (const e of events) messages = applyRoomEvent(messages, ledger, CONV, e);
  return { messages, ledger };
}

describe('a member speaking in the room', () => {
  it('applies an authored reaction to its target and removes only the empty member draft', () => {
    const result = {
      kind: 'agent_reaction',
      success: true,
      completesTurn: true,
      conversationId: CONV,
      messageId: 'person',
      actorId: 'nadia',
      reactions: [],
      reactionEntries: [{ emoji: '❤️', author: { kind: 'agent', id: 'nadia', name: 'Nadia' } }],
      revision: 1,
      mutationId: 'agent-reaction-1',
    };
    const { messages, ledger } = run(
      [
        start(),
        event('alia.agent_tool', {
          consultId: 'k1',
          phase: 'result',
          toolCallId: 'reaction',
          name: 'react_to_message',
          output: result,
        }),
        end({ status: 'completed', reactionOnly: true }),
        start(),
        delta('Late duplicate'),
      ],
      [{ id: 'person', role: 'user', content: 'Gracias' }],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'person', reactionEntries: result.reactionEntries });
    expect(ledger.discarded.has('k1')).toBe(true);
  });

  it('lets authoritative reaction-only completion settle a claimed SSE draft once', () => {
    const ledger = createRoomLedger();
    claimConsult(ledger, 'k1', 'sse-draft');
    const { messages } = run(
      [end({ status: 'completed', reactionOnly: true }), start()],
      [
        { id: 'person', role: 'user', content: 'Gracias' },
        { id: 'sse-draft', role: 'assistant', content: '', isStreaming: true, agentInfo: NADIA },
        { id: 'peer', role: 'assistant', content: 'Earlier completed answer' },
      ],
      ledger,
    );
    expect(messages.map((m) => m.id)).toEqual(['person', 'peer']);
  });

  it('preserves substantive words even if a reaction-only marker is inconsistent', () => {
    const { messages } = run([
      start(),
      delta('A real answer'),
      end({ status: 'completed', reactionOnly: true }),
    ]);
    expect(messages[0]).toMatchObject({
      content: 'A real answer',
      isStreaming: false,
      turnOutcome: 'completed',
    });
  });

  it('preserves unrelated tool cards even beside an inconsistent reaction-only completion', () => {
    const { messages } = run([
      start(),
      event('alia.agent_tool', {
        consultId: 'k1',
        phase: 'call',
        toolCallId: 'question',
        name: 'askUserQuestion',
        input: { questions: [] },
      }),
      end({ status: 'completed', reactionOnly: true }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolInvocations?.[0]?.toolCallId).toBe('question');
    expect(messages[0]?.isStreaming).toBe(false);
  });

  it('shows the member typing from agent_start, as an agent message', () => {
    const { messages } = run([start()]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: '',
      isStreaming: true,
      agentInfo: { id: 'nadia', name: 'Nadia', color: 'teal' },
    });
  });

  it('streams deltas and tool phases into that message', () => {
    const { messages } = run([
      start(),
      delta('Hola '),
      event('alia.agent_tool', {
        consultId: 'k1',
        phase: 'call',
        toolCallId: 't1',
        name: 'search',
        input: { q: 'a' },
      }),
      event('alia.agent_tool', {
        consultId: 'k1',
        phase: 'result',
        toolCallId: 't1',
        name: 'search',
        output: { n: 1 },
      }),
      delta('a todos'),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Hola a todos');
    expect(messages[0]?.toolInvocations).toEqual([
      { toolCallId: 't1', toolName: 'search', state: 'result', args: { q: 'a' }, result: { n: 1 } },
    ]);
  });

  it('turns the draft into the stored reply at agent_end, by messageId, then dedupes group.message', () => {
    const { messages } = run([
      start(),
      delta('Hola'),
      end({ status: 'completed', content: 'Hola a todos', messageId: 'group-reply-p1-0' }),
      reply('group-reply-p1-0', 'Hola a todos'),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'group-reply-p1-0',
      content: 'Hola a todos',
      isStreaming: false,
      turnOutcome: 'completed',
      createdAt: '2026-11-09T10:00:00.000Z',
    });
    expect(messages[0]?.unsaved).toBeUndefined();
  });

  it('keeps one message when group.message arrives before agent_end', () => {
    const { messages } = run([
      start(),
      delta('Hola'),
      reply('group-reply-p1-0', 'Hola a todos'),
      end({ status: 'completed', content: 'Hola a todos', messageId: 'group-reply-p1-0' }),
    ]);
    expect(messages.map((m) => m.id)).toEqual(['group-reply-p1-0']);
    expect(messages[0]?.isStreaming).toBe(false);
  });

  it('appends a stored reply nobody was typing, once', () => {
    const e = reply('group-reply-p1-1', 'Hi');
    const { messages } = run([e, e]);
    expect(messages.map((m) => m.id)).toEqual(['group-reply-p1-1']);
  });

  it('keeps arrival order across members', () => {
    const { messages } = run([
      start('k1'),
      event('alia.agent_start', { consultId: 'k2', agent: { id: 'ben', name: 'Ben' } }),
      end({ status: 'completed', content: 'a', messageId: 'r-0' }, 'k1'),
      end({ status: 'completed', content: 'b', messageId: 'r-1' }, 'k2'),
    ]);
    expect(messages.map((m) => [m.id, m.agentInfo?.name])).toEqual([
      ['r-0', 'Nadia'],
      ['r-1', 'Ben'],
    ]);
  });

  it('applies nothing twice', () => {
    const { messages } = run([
      start(),
      start(),
      delta('a'),
      end({ status: 'completed', content: 'a', messageId: 'r-0' }),
      end({ status: 'completed', content: 'a', messageId: 'r-0' }),
      delta('late'),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('a');
  });

  it.each(['end-first', 'message-only'] as const)(
    'recovers a stored reply after a failed attempt without duplicating it (%s)',
    (replay) => {
      const id = 'group-reply-p1-1';
      const failed = run([
        start(id),
        delta('Partial', id),
        end({ status: 'failed', error: { code: 'store_failed' } }, id),
      ]);
      expect(failed.messages[0]?.turnOutcome).toBe('failed');
      const completed = end({ status: 'completed', content: 'Stored answer', messageId: id }, id);
      const { messages, ledger } = run(
        [
          start(id),
          ...(replay === 'end-first' ? [completed] : []),
          reply(id, 'Stored answer'),
          completed,
          reply(id, 'Stored answer'),
          delta('late duplicate', id),
          end({ status: 'failed', error: { code: 'store_failed' } }, id),
        ],
        failed.messages,
        failed.ledger,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id,
        content: 'Stored answer',
        turnOutcome: 'completed',
        isStreaming: false,
      });
      expect(messages[0]?.unsaved).toBeUndefined();
      expect(ledger.messages.get(id)).toBe(id);
    },
  );

  it.each([false, true])(
    'recovers a stored completion claimed by SSE (released: %s)',
    (released) => {
      const id = 'group-reply-p1-1';
      const ledger = createRoomLedger();
      claimConsult(ledger, id, 'sse-draft');
      if (released) releaseConsult(ledger, id);
      ledger.ended.add(id);
      const { messages } = run(
        [
          start(id),
          end({ status: 'completed', content: 'Stored answer', messageId: id }, id),
          reply(id, 'Stored answer'),
        ],
        [
          {
            id: 'sse-draft',
            role: 'assistant',
            content: 'Partial',
            turnOutcome: 'failed',
            agentInfo: NADIA,
          },
        ],
        ledger,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ id, content: 'Stored answer', turnOutcome: 'completed' });
    },
  );

  it('does not revive an explicitly discarded reply through a late completion replay', () => {
    const id = 'group-reply-p1-1';
    const { messages, ledger } = run([
      start(id),
      delta('Superseded draft', id),
      end({ status: 'declined' }, id),
      start(id),
      end({ status: 'completed', messageId: id, content: 'Stale answer' }, id),
      reply(id, 'Stale answer'),
    ]);
    expect(messages).toEqual([]);
    expect(ledger.discarded.has(id)).toBe(true);
  });

  it('ends a failed member as failed, and a declined one as nothing', () => {
    const failed = run([start(), end({ status: 'failed', error: { code: 'agent_unavailable' } })]);
    expect(failed.messages[0]).toMatchObject({ isStreaming: false, turnOutcome: 'failed' });
    const declined = run([start(), end({ status: 'declined' })]);
    expect(declined.messages).toEqual([]);
  });

  it('never shows room_continues as a failure', () => {
    const { messages } = run([
      start(),
      delta('a'),
      end({ status: 'failed', error: { code: 'room_continues' } }),
    ]);
    expect(messages[0]).toMatchObject({ isStreaming: true });
    expect(messages[0]?.turnOutcome).toBeUndefined();
  });

  it('clears typing at group.idle: an empty draft goes, a spoken one stops', () => {
    const { messages } = run([
      start('k1'),
      start('k2'),
      delta('half', 'k2'),
      event('group.idle', { reason: 'done' }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ content: 'half', isStreaming: false });
  });

  it.each(['error', 'rate_limited', 'turn_cap', 'reply_cap'])(
    'marks only unfinished room output failed when the chain ends with %s',
    (reason) => {
      const { messages } = run([
        start('k1'),
        end({ status: 'completed', content: 'Finished', messageId: 'group-reply-p1-0' }, 'k1'),
        start('k2'),
        delta('unfinished', 'k2'),
        start('k3'),
        event('group.idle', { reason }),
      ]);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        content: 'Finished',
        turnOutcome: 'completed',
        isStreaming: false,
      });
      expect(messages[1]).toMatchObject({
        content: 'unfinished',
        turnOutcome: 'failed',
        isStreaming: false,
      });
    },
  );

  it('ignores events of other conversations and malformed ones', () => {
    const before: Message[] = [];
    const ledger = createRoomLedger();
    expect(
      applyRoomEvent(
        before,
        ledger,
        CONV,
        event('alia.agent_start', { consultId: 'k1', agent: NADIA }, 'other'),
      ),
    ).toBe(before);
    expect(
      applyRoomEvent(before, ledger, CONV, event('alia.agent_start', { consultId: 'k1' })),
    ).toBe(before);
    expect(applyRoomEvent(before, ledger, CONV, event('group.message', { message: {} }))).toBe(
      before,
    );
    expect(
      applyRoomEvent(before, ledger, CONV, { conversationId: CONV, event: 'x', data: null }),
    ).toBe(before);
    expect(ledger.messages.size).toBe(0);
  });
});

describe('a member the chat request already drew', () => {
  const requestMessage = (content = 'Hola'): Message => ({
    id: 'a-agent-0',
    role: 'assistant',
    content,
    isStreaming: true,
    unsaved: true,
    agentInfo: NADIA,
  });

  it('is not drawn or streamed again by the socket, but is reconciled to the stored id', () => {
    const ledger = createRoomLedger();
    claimConsult(ledger, 'k1', 'a-agent-0');
    const { messages } = run(
      [
        start(),
        delta(' duplicated'),
        end({ status: 'completed', content: 'Hola a todos', messageId: 'group-reply-p1-0' }),
        reply('group-reply-p1-0', 'Hola a todos'),
      ],
      [requestMessage()],
      ledger,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'group-reply-p1-0',
      content: 'Hola a todos',
      isStreaming: false,
    });
  });

  it('continues on the socket once the request ended with room_continues', () => {
    const ledger = createRoomLedger();
    claimConsult(ledger, 'k1', 'a-agent-0');
    expect(isRoomOwned(ledger, 'a-agent-0')).toBe(false);
    releaseConsult(ledger, 'k1');
    expect(isRoomOwned(ledger, 'a-agent-0')).toBe(true);
    const { messages } = run([delta(' mundo')], [requestMessage()], ledger);
    expect(messages[0]?.content).toBe('Hola mundo');
  });

  it('adopts a draft the socket drew first, and empties it for the request to say it all', () => {
    const ledger = createRoomLedger();
    const drawn = run([start(), delta('Ho')], [], ledger);
    expect(claimConsult(ledger, 'k1', 'a-agent-0')).toBe('room-k1');
    expect(drawn.messages).toHaveLength(1);
  });
});

describe('room chain ownership', () => {
  const inChain = (chainId: string, frame: RoomEvent): RoomEvent => ({ ...frame, chainId });

  it.each(['done', 'superseded', 'error'])(
    'a delayed old-chain %s cannot settle a new chain',
    (reason) => {
      const { messages, ledger } = run([
        inChain('old', start('old-consult')),
        inChain('old', delta('old output', 'old-consult')),
        inChain('new', start('new-consult')),
        inChain('new', delta('new output', 'new-consult')),
        inChain('old', event('group.idle', { reason })),
      ]);
      expect(messages[0]).toMatchObject({ content: 'old output', isStreaming: false });
      expect(messages[1]).toMatchObject({ content: 'new output', isStreaming: true });
      expect(messages[1]?.turnOutcome).toBeUndefined();
      expect(ledger.ended.has('old-consult')).toBe(true);
      expect(ledger.ended.has('new-consult')).toBe(false);
    },
  );

  it.each([
    start('claimed'),
    delta('duplicate', 'claimed'),
    event('alia.agent_tool', {
      consultId: 'claimed',
      phase: 'call',
      toolCallId: 't1',
      name: 'search',
    }),
    end({ status: 'failed', error: { code: 'room_continues' } }, 'claimed'),
  ])('learns the chain from an SSE-owned $event before release', (socketEvent) => {
    const ledger = createRoomLedger();
    claimConsult(ledger, 'claimed', 'sse-reply');
    const initial: Message[] = [
      { id: 'sse-reply', role: 'assistant', content: 'SSE text', isStreaming: true },
    ];
    const observed = run([inChain('new', socketEvent)], initial, ledger);
    expect(ledger.chains.get('claimed')).toBe('new');
    expect(observed.messages).toEqual(initial);
    releaseConsult(ledger, 'claimed');
    const oldEnded = run(
      [inChain('old', event('group.idle', { reason: 'error' }))],
      observed.messages,
      ledger,
    );
    expect(oldEnded.messages[0]?.isStreaming).toBe(true);
    const ownEnded = run(
      [inChain('new', event('group.idle', { reason: 'error' }))],
      oldEnded.messages,
      ledger,
    );
    expect(ownEnded.messages[0]).toMatchObject({
      content: 'SSE text',
      isStreaming: false,
      turnOutcome: 'failed',
    });
  });

  it('leaves unknown released SSE ownership alone until the synthetic silence timeout', () => {
    const ledger = createRoomLedger();
    claimConsult(ledger, 'unknown', 'sse-reply');
    releaseConsult(ledger, 'unknown');
    const initial: Message[] = [
      { id: 'sse-reply', role: 'assistant', content: 'SSE text', isStreaming: true },
    ];
    const afterIdle = run([event('group.idle', { reason: 'error' })], initial, ledger);
    expect(afterIdle.messages).toBe(initial);
    expect(ledger.ended.has('unknown')).toBe(false);
    const afterSilence = run(
      [{ conversationId: CONV, event: 'group.idle', data: { reason: 'silent' } }],
      afterIdle.messages,
      ledger,
    );
    expect(afterSilence.messages[0]).toMatchObject({ content: 'SSE text', isStreaming: false });
  });

  it('ignores unscoped real terminals and does not let a conflicting event reassign a consult', () => {
    const ledger = createRoomLedger();
    const started = run([inChain('new', start()), inChain('new', delta('current'))], [], ledger);
    const result = run(
      [
        inChain('old', delta('incorrect')),
        { conversationId: CONV, event: 'group.idle', data: { reason: 'error' } },
        inChain('old', event('group.idle', { reason: 'error' })),
      ],
      started.messages,
      ledger,
    );
    expect(result.messages[0]).toMatchObject({ content: 'current', isStreaming: true });
    expect(ledger.chains.get('k1')).toBe('new');
  });
});
