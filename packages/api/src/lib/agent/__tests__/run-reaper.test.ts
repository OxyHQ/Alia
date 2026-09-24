import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  lapsed: vi.fn(),
  failExhausted: vi.fn(),
  enqueue: vi.fn(),
  refund: vi.fn(),
  markRun: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentSessionRepository.js', () => ({
  listLapsedAgentSessionRuns: H.lapsed,
  failExhaustedAgentSessionRun: H.failExhausted,
  RUNNER_MAX_ATTEMPTS: 3,
}));
vi.mock('../../../db/agents/agentRuntimeRepository.js', () => ({ expireAgentApprovals: vi.fn(async () => []) }));
vi.mock('../../../db/automation/automationDefinitionRepository.js', () => ({ markAutomationRunForSession: H.markRun }));
vi.mock('../../credits-manager.js', () => ({ safeRefund: H.refund }));
vi.mock('../../notification-service.js', () => ({ sendNotification: H.notify }));
vi.mock('../../task-queue.js', () => ({ enqueueAgentSession: H.enqueue }));
vi.mock('../session-handoff.js', () => ({ reclaimOrphanedAgentSessions: vi.fn(async () => 0) }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child } };
});

import { reapAgentRuns } from '../run-reaper.js';

const HOLD = { oxyUserId: 'u', creditsReserved: 5, initialFreeCredits: 5, initialPaidCredits: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  H.notify.mockResolvedValue(undefined);
});

describe('the agent run reaper', () => {
  it('hands a lapsed run back to the queue as a new, attempt-named job', async () => {
    H.lapsed.mockResolvedValue([{ id: 's1', oxyUserId: 'u', agentId: 'a', attempts: 1, creditReservation: HOLD }]);

    await expect(reapAgentRuns()).resolves.toEqual({ resumed: 1, failed: 0 });
    expect(H.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', userId: 'u', agentId: 'a' }),
      { resumeAttempt: 1 },
    );
    expect(H.refund).not.toHaveBeenCalled();
  });

  it('fails, refunds and tells the person about a run that keeps losing its worker', async () => {
    H.lapsed.mockResolvedValue([{ id: 's2', oxyUserId: 'u', agentId: 'a', attempts: 3, creditReservation: HOLD }]);
    H.failExhausted.mockResolvedValue({ id: 's2', creditReservation: HOLD });

    await expect(reapAgentRuns()).resolves.toEqual({ resumed: 0, failed: 1 });
    expect(H.enqueue).not.toHaveBeenCalled();
    expect(H.refund).toHaveBeenCalledWith(HOLD, 'run interrupted too many times');
    expect(H.markRun).toHaveBeenCalledWith(expect.anything(), 's2', 'failed');
    expect(H.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u' }));
  });

  it('does nothing for an exhausted run another task already settled', async () => {
    H.lapsed.mockResolvedValue([{ id: 's3', oxyUserId: 'u', agentId: 'a', attempts: 3, creditReservation: HOLD }]);
    H.failExhausted.mockResolvedValue(null);

    await expect(reapAgentRuns()).resolves.toEqual({ resumed: 0, failed: 0 });
    expect(H.refund).not.toHaveBeenCalled();
    expect(H.notify).not.toHaveBeenCalled();
  });
});
