import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  findRun: vi.fn(),
  findDefinition: vi.fn(),
  listSteps: vi.fn(),
  markRun: vi.fn(),
  memory: vi.fn(),
  oxyUser: vi.fn(),
  post: vi.fn(),
  resolveModel: vi.fn(),
  getModel: vi.fn(),
  forUser: vi.fn(),
  generate: vi.fn(),
  finalize: vi.fn(),
  refund: vi.fn(),
  notify: vi.fn(),
}));

const database = { kind: 'test-db' };

vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  findAutomationRunById: state.findRun,
  findAutomationDefinitionById: state.findDefinition,
  listAutomationRunSteps: state.listSteps,
  markAliaAutomationRun: state.markRun,
}));
vi.mock('../../db/memory/userMemoryRepository.js', () => ({ findUserMemory: state.memory }));
vi.mock('../../middleware/auth.js', () => ({ oxyClient: { users: { get: state.oxyUser } } }));
vi.mock('../agent/alia-outreach.js', () => ({ postAliaMessage: state.post }));
vi.mock('../chat-core.js', () => ({ resolveDefaultModel: state.resolveModel, getAIModel: state.getModel }));
vi.mock('../tool-pipeline.js', () => ({ ToolPipeline: { forUser: state.forUser } }));
vi.mock('../credits-manager.js', () => ({ finalizeCredits: state.finalize, safeRefund: state.refund }));
vi.mock('../notification-service.js', () => ({ sendNotification: state.notify }));
vi.mock('ai', () => ({ generateText: state.generate, stepCountIs: (count: number) => ({ stepCount: count }) }));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child } };
});

import { ALIA_TASK_MAX_STEPS, runAliaTask } from '../alia-task-run.js';

const RESERVATION = { userId: 'owner-1', creditsReserved: 10, initialFreeCredits: 100, initialPaidCredits: 0, grantKind: 'free' };
const job = {
  runId: 'run-1',
  automationId: 'automation-1',
  userId: 'owner-1',
  creditReservation: RESERVATION,
} as never;

const taskInput = {
  objective: 'Track the latest releases from Meta',
  trigger: { type: 'schedule', occurrenceId: 'occ-1', occurredAt: '2026-09-30T09:00:00.000Z' },
  inputs: { instructions: 'Tell me when Meta announces something new' },
  actions: [],
  receivePreviousResult: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.findRun.mockResolvedValue({ id: 'run-1', automationId: 'automation-1', selectedActorType: 'alia', status: 'planned' });
  state.findDefinition.mockResolvedValue({
    id: 'automation-1',
    ownerAccountId: 'owner-1',
    objective: 'Track the latest releases from Meta',
    conversationId: 'conversation-1',
  });
  state.listSteps.mockResolvedValue([{ tool: 'alia.run', input: taskInput }]);
  state.markRun.mockResolvedValue(undefined);
  state.memory.mockResolvedValue(null);
  state.oxyUser.mockResolvedValue({ id: 'owner-1', username: 'nate' });
  state.post.mockResolvedValue({ posted: true, conversationId: 'conversation-1', messageId: 'agent-push-1' });
  state.resolveModel.mockReturnValue({ modelId: 'auto' });
  state.getModel.mockReturnValue({ model: 'handle' });
  state.forUser.mockResolvedValue({ tools: { webSearch: {} }, routing: {}, appCatalogPrompt: '' });
  state.generate.mockResolvedValue({
    text: 'Meta announced Llama 5 today.',
    totalUsage: { inputTokens: 1200, outputTokens: 300 },
    // The model Oxy chose for the `auto` level, as the adapter reports it.
    providerMetadata: { kaana: { resolvedModelReference: 'publisher/default-model@2026-09-01' } },
  });
  state.finalize.mockResolvedValue({ creditsCharged: 3, creditsRemaining: 97 });
  state.refund.mockResolvedValue(undefined);
  state.notify.mockResolvedValue(undefined);
});

describe('an Alia task run', () => {
  it('runs one Alia turn for the owner and posts the answer into the task conversation', async () => {
    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('completed');

    expect(state.resolveModel).toHaveBeenCalledWith();
    expect(state.forUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      actsForPerson: true,
      isDirectSession: false,
      agent: null,
      toolsEnabled: true,
      webSearch: true,
      runId: 'run-1',
    }));
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: { model: 'handle' },
      stopWhen: { stepCount: ALIA_TASK_MAX_STEPS },
      messages: [
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: expect.stringContaining('Track the latest releases from Meta') },
      ],
    }));
    expect(state.finalize).toHaveBeenCalledWith(
      RESERVATION,
      { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 },
      'publisher/default-model',
    );
    expect(state.markRun).toHaveBeenNthCalledWith(1, database, 'run-1', 'running');
    expect(state.markRun).toHaveBeenLastCalledWith(database, 'run-1', 'succeeded');
    expect(state.post).toHaveBeenCalledWith({
      oxyUserId: 'owner-1',
      automationId: 'automation-1',
      objective: 'Track the latest releases from Meta',
      conversationId: 'conversation-1',
      content: 'Meta announced Llama 5 today.',
    });
    expect(state.refund).not.toHaveBeenCalled();
  });

  it('keeps the hold for the retry when an earlier attempt fails', async () => {
    state.generate.mockRejectedValueOnce(new Error('upstream unavailable'));

    await expect(runAliaTask(job, { finalAttempt: false })).rejects.toThrow('upstream unavailable');
    expect(state.refund).not.toHaveBeenCalled();
    expect(state.markRun).not.toHaveBeenCalledWith(database, 'run-1', 'failed');
    expect(state.post).not.toHaveBeenCalled();
  });

  it('refunds, fails the run and tells the person in the task conversation on the last attempt', async () => {
    state.generate.mockRejectedValueOnce(new Error('upstream unavailable'));

    await expect(runAliaTask(job, { finalAttempt: true })).rejects.toThrow('upstream unavailable');
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'Alia task failed');
    expect(state.markRun).toHaveBeenLastCalledWith(database, 'run-1', 'failed');
    expect(state.finalize).not.toHaveBeenCalled();
    expect(state.post).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      content: expect.stringContaining("couldn't complete this scheduled task"),
    }));
    // The raw upstream reason never reaches the person.
    expect(JSON.stringify(state.post.mock.calls)).not.toContain('upstream');
  });

  it('falls back to a notification when the failure cannot be posted', async () => {
    state.generate.mockRejectedValueOnce(new Error('upstream unavailable'));
    state.post.mockRejectedValueOnce(new Error('database unreachable'));

    await expect(runAliaTask(job, { finalAttempt: true })).rejects.toThrow('upstream unavailable');
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'Alia task failed');
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      data: expect.objectContaining({ automationId: 'automation-1', runId: 'run-1', status: 'failed' }),
    }));
  });

  it('does not rerun or recharge a run that already settled', async () => {
    state.findRun.mockResolvedValueOnce({ id: 'run-1', automationId: 'automation-1', selectedActorType: 'alia', status: 'succeeded' });

    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('skipped');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.refund).not.toHaveBeenCalled();
  });

  it('gives the hold back when the task was deleted before it ran', async () => {
    state.findDefinition.mockResolvedValueOnce(null);

    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('failed');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.markRun).toHaveBeenCalledWith(database, 'run-1', 'failed');
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'Alia task definition not found');
  });
});
