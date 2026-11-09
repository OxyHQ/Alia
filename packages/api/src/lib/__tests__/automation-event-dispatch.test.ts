import { beforeEach, describe, expect, it, vi } from 'vitest';

const claim = vi.fn();
const mark = vi.fn(() => Promise.resolve());
const match = vi.fn();
const dispatch = vi.fn(() => Promise.resolve());
const notify = vi.fn(() => Promise.resolve());

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  claimStalledAutomationEvents: claim,
  markAutomationEventStatus: mark,
  matchingEventAutomations: match,
}));
vi.mock('../automation-dispatcher.js', () => ({ dispatchStructuredAutomation: dispatch }));
vi.mock('../notification-service.js', () => ({ sendNotification: notify }));
const routeToInboxes = vi.fn(() => Promise.resolve(0));
vi.mock('../agent/inbox-router.js', () => ({ routeEventToAgentInboxes: routeToInboxes }));

const { reapStalledAutomationEvents, STALLED_AFTER_MS } = await import(
  '../automation-event-dispatch.js'
);

const event = (eventId: string) => ({
  eventId,
  appId: 'inbox',
  accountId: 'user-1',
  resource: {
    appId: 'inbox',
    effectiveAccountId: 'user-1',
    resourceType: 'mailbox',
    resourceId: 'm1',
  },
  eventType: 'new_email',
  occurredAt: new Date('2026-11-09T10:00:00Z'),
  data: {},
});

describe('reapStalledAutomationEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claims only events older than the stall window and dispatches each one', async () => {
    const now = new Date('2026-11-09T12:00:00Z');
    claim.mockResolvedValue([event('e1'), event('e2')]);
    match.mockResolvedValue([{ id: 'auto-1' }]);

    expect(await reapStalledAutomationEvents(now)).toBe(2);

    expect(claim).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ now, staleMs: STALLED_AFTER_MS }),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(mark).toHaveBeenCalledWith({}, 'inbox', 'e1', 'processed');
  });

  it('marks an event with no automation processed without dispatching', async () => {
    claim.mockResolvedValue([event('e1')]);
    match.mockResolvedValue([]);
    await reapStalledAutomationEvents();
    expect(dispatch).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith({}, 'inbox', 'e1', 'processed');
  });

  it('records a failing event as failed, tells the person, and keeps going', async () => {
    claim.mockResolvedValue([event('bad'), event('good')]);
    match.mockResolvedValue([{ id: 'auto-1' }]);
    dispatch.mockRejectedValueOnce(new Error('boom'));

    expect(await reapStalledAutomationEvents()).toBe(2);

    expect(mark).toHaveBeenCalledWith({}, 'inbox', 'bad', 'failed');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith({}, 'inbox', 'good', 'processed');
  });

  it('routes a re-dispatched event to agent inboxes even when no automation matches it', async () => {
    claim.mockResolvedValue([event('e1')]);
    match.mockResolvedValue([]);
    await reapStalledAutomationEvents();
    expect(routeToInboxes).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e1' }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing when nothing is stalled', async () => {
    claim.mockResolvedValue([]);
    expect(await reapStalledAutomationEvents()).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
