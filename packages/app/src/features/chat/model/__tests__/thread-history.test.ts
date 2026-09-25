import { describe, expect, it } from 'vitest';

import { threadHistory, threadSeamIds, type ThreadPage, type WireThreadMessage } from '../thread-history';

/**
 * The history above the live conversation, and where the joins are.
 *
 * Both orderings are exercised on purpose. Pages arrive newest-first and their
 * contents oldest-first, so an implementation that reverses the wrong one reads
 * perfectly in a single-page fixture and scrambles the moment a second page is
 * scrolled to — which is the only situation this function exists for.
 */

function wire(over: Partial<WireThreadMessage> & { cursor: string; conversationId: string }): WireThreadMessage {
  return {
    role: 'user',
    content: 'said something',
    ...over,
  };
}

function page(messages: WireThreadMessage[], nextCursor: string | null = null): ThreadPage {
  return { messages, nextCursor };
}

describe('the history above the live conversation', () => {
  it('reads oldest-first across pages, and pages arrive the other way round', () => {
    const newest = page([
      wire({ id: 'c', cursor: 'k3', conversationId: 'older' }),
      wire({ id: 'd', cursor: 'k4', conversationId: 'older' }),
    ]);
    const older = page([
      wire({ id: 'a', cursor: 'k1', conversationId: 'oldest' }),
      wire({ id: 'b', cursor: 'k2', conversationId: 'oldest' }),
    ]);

    expect(threadHistory([newest, older], 'active').map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves out the stretch that is on screen, which the streaming hook owns', () => {
    // The duplicate this prevents is not cosmetic: the endpoint's copy of a
    // live message is frozen at the moment it was fetched, so an answer would
    // appear twice and only one of the two would keep growing.
    const messages = [
      wire({ id: 'old', cursor: 'k1', conversationId: 'previous' }),
      wire({ id: 'live', cursor: 'k2', conversationId: 'active' }),
    ];

    expect(threadHistory([page(messages)], 'active').map((m) => m.id)).toEqual(['old']);
  });

  it('gives a server-written message its cursor as an id', () => {
    // `id` is the CLIENT's id and a message the server wrote never had one, yet
    // it is what the list keys on and what the vote URL carries. A cursor
    // addresses exactly one message, so it is the id that message can have.
    const [message] = threadHistory([page([wire({ cursor: 'k9', conversationId: 'previous' })])], 'active');

    expect(message.id).toBe('k9');
    expect(message.cursor).toBe('k9');
  });

  it('keeps a client id when the message has one', () => {
    const [message] = threadHistory(
      [page([wire({ id: 'mine', cursor: 'k9', conversationId: 'previous' })])],
      'active',
    );

    expect(message.id).toBe('mine');
  });

  it('is empty when the whole page is the live stretch, which is not the same as being finished', () => {
    // A long active conversation fills the first page by itself. Nothing is
    // rendered above, and yet there is more to load — which is why "nothing
    // came back" must never be what stops the paging. `nextCursor` decides.
    const messages = [wire({ id: 'live', cursor: 'k1', conversationId: 'active' })];

    expect(threadHistory([page(messages, 'k0')], 'active')).toEqual([]);
  });
});

describe('the seams between conversations', () => {
  const history = threadHistory(
    [
      page([
        wire({ id: 'a', cursor: 'k1', conversationId: 'first' }),
        wire({ id: 'b', cursor: 'k2', conversationId: 'first' }),
        wire({ id: 'c', cursor: 'k3', conversationId: 'second' }),
      ]),
    ],
    'active',
  );

  it('marks the message that begins a new conversation', () => {
    expect(threadSeamIds(history, [], 'active')).toEqual(new Set(['c']));
  });

  it('never marks the topmost message, because what is above it is not loaded yet', () => {
    // Whether a break sits above the first loaded message is a fact about a
    // page nobody has asked for. Drawing one there would claim the thread
    // starts here, and scrolling up would contradict it.
    expect(threadSeamIds(history, [], 'active').has('a')).toBe(false);
  });

  it('marks the first live message when history sits above it', () => {
    const seams = threadSeamIds(history, [{ id: 'live-1' }, { id: 'live-2' }], 'active');

    expect(seams.has('live-1')).toBe(true);
    expect(seams.has('live-2')).toBe(false);
  });

  it('marks nothing at all when there is no history above', () => {
    // An ordinary first conversation: no break has happened, so no line.
    expect(threadSeamIds([], [{ id: 'live-1' }], 'active')).toEqual(new Set());
  });

  it('draws no line when the message above the live one is the live conversation itself', () => {
    // Reachable while a page is in flight and only part of the active stretch
    // has been dropped — the two sides of the join are the same conversation,
    // so there is nothing to separate.
    const sameStretch = threadHistory(
      [page([wire({ id: 'a', cursor: 'k1', conversationId: 'active' })])],
      'other',
    );

    expect(threadSeamIds(sameStretch, [{ id: 'live-1' }], 'active')).toEqual(new Set());
  });
});
