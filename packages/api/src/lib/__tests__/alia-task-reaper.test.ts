import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  list: vi.fn(),
  fail: vi.fn(),
  findDefinition: vi.fn(),
  post: vi.fn(),
  refund: vi.fn(),
  notify: vi.fn(),
}));

const database = { kind: 'test-db' };

vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  listAbandonedAliaRuns: state.list,
  failAbandonedAliaRun: state.fail,
  findAutomationDefinitionById: state.findDefinition,
}));
vi.mock('../agent/alia-outreach.js', () => ({ postAliaMessage: state.post }));
vi.mock('../credits-manager.js', () => ({ safeRefund: state.refund }));
vi.mock('../notification-service.js', () => ({ sendNotification: state.notify }));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child } };
});

import { ALIA_RUN_PICKUP_GRACE_MS, reapAbandonedAliaRuns } from '../alia-task-reaper.js';

const HOLD = {
  userId: 'owner-1',
  creditsReserved: 10,
  initialFreeCredits: 5,
  initialPaidCredits: 0,
  grantKind: 'free',
};
const NOW = new Date('2026-10-01T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  state.list.mockResolvedValue(['run-1']);
  state.fail.mockResolvedValue({
    id: 'run-1',
    automationId: 'automation-1',
    requesterAccountId: 'owner-1',
    creditReservation: HOLD,
  });
  state.findDefinition.mockResolvedValue({
    id: 'automation-1',
    ownerAccountId: 'owner-1',
    objective: 'Morning summary',
    conversationId: 'conversation-1',
  });
  state.post.mockResolvedValue({ posted: true });
  state.refund.mockResolvedValue(undefined);
  state.notify.mockResolvedValue(undefined);
});

describe('the Alia run reaper', () => {
  it('fails an abandoned run, refunds its hold and tells the person in the task conversation', async () => {
    await expect(reapAbandonedAliaRuns(NOW)).resolves.toEqual({ failed: 1 });

    const plannedBefore = new Date(NOW.getTime() - ALIA_RUN_PICKUP_GRACE_MS);
    expect(state.list).toHaveBeenCalledWith(database, NOW, plannedBefore);
    expect(state.fail).toHaveBeenCalledWith(database, 'run-1', NOW, plannedBefore);
    expect(state.refund).toHaveBeenCalledWith(HOLD, 'Alia task run abandoned');
    expect(state.post).toHaveBeenCalledWith(
      expect.objectContaining({
        oxyUserId: 'owner-1',
        automationId: 'automation-1',
        conversationId: 'conversation-1',
      }),
    );
  });

  it('does nothing for a run another task or its worker closed first', async () => {
    state.fail.mockResolvedValueOnce(null);

    await expect(reapAbandonedAliaRuns(NOW)).resolves.toEqual({ failed: 0 });
    expect(state.refund).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
  });

  it('notifies instead when the task conversation is out of reach', async () => {
    state.findDefinition.mockResolvedValueOnce(null);

    await reapAbandonedAliaRuns(NOW);
    expect(state.refund).toHaveBeenCalled();
    expect(state.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        data: expect.objectContaining({ runId: 'run-1', status: 'failed' }),
      }),
    );
  });

  it('keeps sweeping when one run cannot be reaped', async () => {
    state.list.mockResolvedValueOnce(['run-1', 'run-2']);
    state.fail.mockRejectedValueOnce(new Error('db blip'));

    await expect(reapAbandonedAliaRuns(NOW)).resolves.toEqual({ failed: 1 });
  });
});
