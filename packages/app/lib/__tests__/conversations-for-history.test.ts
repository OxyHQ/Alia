import { describe, expect, it } from 'vitest';

import { conversationsForHistory } from '../sidebar-history';
import type { Conversation } from '../hooks/use-conversations';

/**
 * What the sidebar's History is allowed to list.
 *
 * An agent gets ONE row, in the Agents section, whatever number of conversations
 * its thread is made of. Every one of those conversations reaching History too
 * is the failure this guards: an agent talked to five times would put five rows
 * beside its single row above, which is the shape the permanent thread exists to
 * replace.
 *
 * The case that decides whether the filter works at all is `agentId: null`. The
 * column is `agent_id text` and `GET /conversations` sends `c.agentId` straight
 * through, so an ordinary conversation arrives carrying an explicit null — a
 * filter written against `undefined` keeps every agent conversation, and one
 * written against `null` alone hides every conversation restored from local
 * storage, which carries neither. Both are asserted.
 */

function conversation(id: string, agentId?: string | null): Conversation {
  return {
    id,
    title: id,
    createdAt: new Date('2026-03-04T09:00:00Z'),
    updatedAt: new Date('2026-03-04T09:00:00Z'),
    messages: [],
    ...(agentId === undefined ? {} : { agentId }),
  };
}

const ids = (conversations: readonly Conversation[]) => conversations.map((c) => c.id);

describe('the conversations History lists', () => {
  it("leaves out a conversation that belongs to an agent's thread", () => {
    const kept = conversationsForHistory(
      [conversation('plain', null), conversation('with-pepe', 'agent_pepe')],
      [],
    );

    expect(ids(kept)).toEqual(['plain']);
  });

  it('keeps the ordinary conversation the server sends, which carries an explicit null', () => {
    // The positive control for the line above: if this list came back empty,
    // the filter would be hiding the entire history rather than one thread.
    expect(ids(conversationsForHistory([conversation('plain', null)], []))).toEqual(['plain']);
  });

  it('keeps a conversation restored from local storage, which carries no field at all', () => {
    expect(ids(conversationsForHistory([conversation('offline')], []))).toEqual(['offline']);
  });

  it('still leaves out a conversation that belongs to a project', () => {
    // The exclusion that was already there, kept honest while a second one
    // joined it.
    const kept = conversationsForHistory(
      [conversation('loose', null), conversation('filed', null)],
      [{ conversationIds: ['filed'] }],
    );

    expect(ids(kept)).toEqual(['loose']);
  });

  it('leaves out a conversation excluded by both, once', () => {
    const kept = conversationsForHistory(
      [conversation('plain', null), conversation('both', 'agent_pepe')],
      [{ conversationIds: ['both'] }],
    );

    expect(ids(kept)).toEqual(['plain']);
  });

  it('lists everything when there is nothing to exclude', () => {
    const all = [conversation('a', null), conversation('b', null)];

    expect(ids(conversationsForHistory(all, []))).toEqual(['a', 'b']);
  });
});
