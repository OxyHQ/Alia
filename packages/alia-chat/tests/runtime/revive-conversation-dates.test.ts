import { describe, expect, it } from 'vitest';

import { reviveConversationDates } from '../../src/runtime/conversation-dates';

const row = (updatedAt: unknown, createdAt: unknown = updatedAt) =>
  ({ id: 'c1', title: 't', createdAt, updatedAt, messages: [] }) as never;
const page = (...conversations: never[]) =>
  ({
    pages: [{ conversations, nextCursor: null, hasMore: false }],
    pageParams: [undefined],
  }) as never;

describe('reviveConversationDates', () => {
  it('turns the ISO strings a persisted cache hands back into Dates', () => {
    const revived = reviveConversationDates(page(row('2026-11-09T08:00:00.000Z')));
    const [first] = revived.pages[0]!.conversations;
    expect(first!.updatedAt).toBeInstanceOf(Date);
    expect(first!.updatedAt.getTime()).toBe(Date.parse('2026-11-09T08:00:00.000Z'));
    expect(first!.createdAt).toBeInstanceOf(Date);
  });

  it('leaves a freshly fetched list alone, the same objects', () => {
    const fresh = page(row(new Date()));
    const revived = reviveConversationDates(fresh);
    expect(revived.pages[0]!.conversations[0]).toBe(
      (fresh as { pages: { conversations: unknown[] }[] }).pages[0]!.conversations[0],
    );
  });
});
