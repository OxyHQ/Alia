import { describe, expect, it } from 'vitest';
import { reactionPills } from '../../src/lib/reaction-pills';
import type { MessageReactionEntry } from '../../src/runtime/types';

const salina: MessageReactionEntry = {
  emoji: '❤️',
  author: { kind: 'agent', id: 'salina', name: 'Salina' },
};
const human: MessageReactionEntry = { emoji: '❤️', author: { kind: 'user', id: 'person' } };

describe('independently authored reaction pills', () => {
  it('keeps an agent heart when the person retracts or rolls back their own heart', () => {
    const together = reactionPills(['❤️'], [human, salina], 'person');
    expect(together).toHaveLength(1);
    expect(together[0]).toMatchObject({ selected: true, authors: expect.any(Array) });
    expect(together[0]?.authors).toHaveLength(2);
    expect(reactionPills([], [human, salina], 'person')).toEqual([
      { emoji: '❤️', selected: false, authors: [salina.author] },
    ]);
  });

  it('counts distinct authors independently and deduplicates repeated delivery', () => {
    const peer: MessageReactionEntry = {
      emoji: '❤️',
      author: { kind: 'agent', id: 'peer', name: 'Salina' },
    };
    expect(reactionPills([], [salina, salina, peer], 'person')[0]?.authors).toEqual([
      salina.author,
      peer.author,
    ]);
  });

  it('does not select another person’s reaction in a shared conversation', () => {
    expect(reactionPills(['❤️'], [human, salina], 'viewer')[0]).toMatchObject({ selected: false });
    expect(reactionPills(['❤️'], [human], undefined)).toEqual([
      { emoji: '❤️', selected: false, authors: [human.author] },
    ]);
  });
});
