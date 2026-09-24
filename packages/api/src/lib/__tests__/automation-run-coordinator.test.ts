import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  createSession: vi.fn(),
  markRun: vi.fn(),
  progress: vi.fn(),
  reserve: vi.fn(),
  refund: vi.fn(),
}));
const database = { kind: 'test-db' };

vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  automationRunProgressForSession: state.progress,
  markAutomationRunForSession: state.markRun,
}));
vi.mock('../../db/agents/agentSessionRepository.js', () => ({
  createAutomationStageSession: state.createSession,
}));
vi.mock('../credits-manager.js', () => ({ reserveCredits: state.reserve, safeRefund: state.refund }));

const RESERVATION = { reservationId: 'hold-2', amount: 1 };

import { advanceAutomationRunAfterSession } from '../automation-run-coordinator.js';

const completedSession = {
  id: 'reader-session',
  result: 'weekly summary',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  state.markRun.mockResolvedValue(undefined);
  state.reserve.mockResolvedValue(RESERVATION);
});

describe('automation run coordinator', () => {
  it('creates the next persisted stage with only its typed handoff', async () => {
    state.progress.mockResolvedValue({
      kind: 'next',
      runId: 'run-1',
      stage: 1,
      agentId: 'publisher',
      actorAccountId: 'publisher-bot',
      ownerAccountId: 'owner-1',
      taskInput: {
        objective: 'Publish a weekly summary',
        trigger: { type: 'prior_stage' },
        inputs: {},
        actions: [{
          resource: {
            appId: 'mention',
            effectiveAccountId: 'owner-1',
            resourceType: 'social_account',
            resourceId: 'profile-1',
          },
          tool: 'publishPost',
          input: {},
        }],
        receivePreviousResult: true,
      },
    });
    state.createSession.mockImplementation(async (_db, input) => ({
      created: true,
      session: { id: 'publisher-session', ...input },
    }));

    await expect(advanceAutomationRunAfterSession(completedSession)).resolves.toEqual(
      expect.objectContaining({ kind: 'next', created: true, runId: 'run-1' }),
    );
    expect(state.createSession).toHaveBeenCalledWith(database, expect.objectContaining({
      automationRunId: 'run-1',
      automationStage: 1,
      agentId: 'publisher',
      task: expect.stringContaining('weekly summary'),
    }));
  });

  it('returns terminal state without creating another session', async () => {
    state.progress.mockResolvedValue({ kind: 'terminal', runId: 'run-1', status: 'succeeded' });
    await expect(advanceAutomationRunAfterSession(completedSession)).resolves.toEqual({
      kind: 'terminal',
      runId: 'run-1',
      status: 'succeeded',
    });
    expect(state.createSession).not.toHaveBeenCalled();
  });

  it('fails closed when a completed session did not finalize its persisted stage', async () => {
    state.progress.mockResolvedValue({ kind: 'invalid', runId: 'run-1' });
    await expect(advanceAutomationRunAfterSession(completedSession)).resolves.toEqual({
      kind: 'terminal',
      runId: 'run-1',
      status: 'failed',
    });
    expect(state.markRun).toHaveBeenCalledWith(database, 'reader-session', 'failed');
    expect(state.createSession).not.toHaveBeenCalled();
  });

  it('fails the run if the next stage cannot be materialized', async () => {
    state.progress.mockResolvedValue({
      kind: 'next',
      runId: 'run-1',
      stage: 1,
      agentId: 'publisher',
      actorAccountId: 'publisher-bot',
      ownerAccountId: 'owner-1',
      taskInput: {},
    });
    state.createSession.mockRejectedValue(new Error('invalid task envelope'));
    await expect(advanceAutomationRunAfterSession(completedSession)).rejects.toThrow();
    expect(state.markRun).toHaveBeenCalledWith(database, 'reader-session', 'failed');
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'automation stage could not be created');
  });

  it('holds credits for the next stage, and stops the run when the owner cannot cover it', async () => {
    const next = {
      kind: 'next',
      runId: 'run-1',
      stage: 1,
      agentId: 'publisher',
      actorAccountId: 'publisher-bot',
      ownerAccountId: 'owner-1',
      taskInput: {
        objective: 'Publish a weekly summary',
        trigger: { type: 'prior_stage' },
        inputs: {},
        actions: [{
          resource: {
            appId: 'mention',
            effectiveAccountId: 'owner-1',
            resourceType: 'social_account',
            resourceId: 'profile-1',
          },
          tool: 'publishPost',
          input: {},
        }],
        receivePreviousResult: true,
      },
    };
    state.progress.mockResolvedValue(next);
    state.createSession.mockResolvedValue({ session: { id: 'stage-1' }, created: true });

    await advanceAutomationRunAfterSession(completedSession);
    expect(state.createSession).toHaveBeenCalledWith(database, expect.objectContaining({ creditReservation: RESERVATION }));

    vi.clearAllMocks();
    state.progress.mockResolvedValue(next);
    state.reserve.mockResolvedValue(null);
    await expect(advanceAutomationRunAfterSession(completedSession))
      .resolves.toEqual({ kind: 'terminal', status: 'failed', runId: 'run-1' });
    expect(state.createSession).not.toHaveBeenCalled();
  });
});
