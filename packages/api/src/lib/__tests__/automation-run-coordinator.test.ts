import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  createSession: vi.fn(),
  markRun: vi.fn(),
  progress: vi.fn(),
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

import { advanceAutomationRunAfterSession } from '../automation-run-coordinator.js';

const completedSession = {
  id: 'reader-session',
  result: 'weekly summary',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  state.markRun.mockResolvedValue(undefined);
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
  });
});
