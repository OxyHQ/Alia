import { beforeEach, describe, expect, it, vi } from 'vitest';

const matching = vi.fn();
const add = vi.fn();
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentInboxRepository.js', () => ({
  matchingAgentSubscriptions: matching,
  addInboxItem: add,
}));

const { routeEventToAgentInboxes } = await import('../inbox-router.js');

const event = {
  eventId: 'evt-1',
  appId: 'inbox',
  accountId: 'owner-1',
  resource: {
    appId: 'inbox',
    effectiveAccountId: 'owner-1',
    resourceType: 'mailbox',
    resourceId: 'm1',
  },
  eventType: 'new_email',
  occurredAt: new Date('2026-11-09T10:00:00Z'),
  data: { subject: 'hola' },
};
const sub = (agentId: string) => ({
  id: `s-${agentId}`,
  agentId,
  ownerAccountId: 'owner-1',
  sourceAccountId: 'owner-1',
  appId: 'inbox',
  eventType: 'new_email',
  enabled: true,
});

describe('routeEventToAgentInboxes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    add.mockResolvedValue(true);
  });

  it('puts the event in the inbox of each subscribed agent, keyed by app and event id', async () => {
    matching.mockResolvedValue([sub('a1'), sub('a2')]);
    expect(await routeEventToAgentInboxes(event)).toBe(2);
    expect(add).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agentId: 'a1',
        ownerAccountId: 'owner-1',
        dedupeKey: 'inbox:evt-1',
        summary: expect.objectContaining({ subject: 'hola', resourceId: 'm1' }),
      }),
    );
  });

  it('tells an agent with two matching subscriptions once', async () => {
    matching.mockResolvedValue([sub('a1'), { ...sub('a1'), id: 'wild', eventType: '*' }]);
    await routeEventToAgentInboxes(event);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('does not count an event the inbox already had', async () => {
    matching.mockResolvedValue([sub('a1')]);
    add.mockResolvedValue(false);
    expect(await routeEventToAgentInboxes(event)).toBe(0);
  });

  it('adds nothing when nobody subscribed', async () => {
    matching.mockResolvedValue([]);
    expect(await routeEventToAgentInboxes(event)).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });
});
