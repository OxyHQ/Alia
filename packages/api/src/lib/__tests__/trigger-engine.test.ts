import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(), validate: vi.fn(() => true) },
}));
vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  findAutomationDefinitionById: vi.fn(),
  listSchedulableAutomationDefinitions: vi.fn(async () => []),
  listSchedulableAutomationVersions: vi.fn(async () => []),
}));
vi.mock('../automation-dispatcher.js', () => ({
  dispatchStructuredAutomation: vi.fn(),
}));
vi.mock('../leader-election.js', () => ({ startLeaderElection: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: { triggers: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import cron, { type TaskContext } from 'node-cron';
import {
  findAutomationDefinitionById,
  listSchedulableAutomationDefinitions,
  listSchedulableAutomationVersions,
  type AutomationDefinitionRecord,
} from '../../db/automation/automationDefinitionRepository.js';
import { dispatchStructuredAutomation } from '../automation-dispatcher.js';
import { startTriggerScheduler, stopAllScheduledTasks } from '../trigger-engine.js';

type MockFn = ReturnType<typeof vi.fn>;
const cronMock = cron as unknown as { schedule: MockFn; validate: MockFn };
const listDefinitions = vi.mocked(listSchedulableAutomationDefinitions);
const listVersions = vi.mocked(listSchedulableAutomationVersions);
const findDefinition = vi.mocked(findAutomationDefinitionById);
const dispatchAutomation = vi.mocked(dispatchStructuredAutomation);

function automation(id: string, updatedAt: Date): AutomationDefinitionRecord {
  return {
    id,
    ownerAccountId: 'owner-1',
    objective: `Automation ${id}`,
    trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
    actorSelection: { mode: 'fixed', agentId: 'agent-1' },
    executionMode: 'observe',
    actions: [],
    inputs: {},
    resources: [],
    dataFlow: { sources: [], destinations: [] },
    maximumAutonomy: 'autonomous',
    limits: [],
    enabled: true,
    legacyTriggerId: null,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    updatedAt,
  };
}

describe('normalized automation schedule reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cronMock.validate.mockReturnValue(true);
    listDefinitions.mockResolvedValue([]);
    listVersions.mockResolvedValue([]);
  });

  afterEach(() => {
    stopAllScheduledTasks();
    vi.useRealTimers();
  });

  it('reschedules an edited definition and stops a removed one', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-09-02T00:00:00.000Z');
    const t1 = new Date('2026-09-02T01:00:00.000Z');
    let rows = [automation('a', t0), automation('b', t0)];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const tasks: Array<{ stop: MockFn }> = [];
    cronMock.schedule.mockImplementation(() => {
      const task = { stop: vi.fn() };
      tasks.push(task);
      return task;
    });
    listDefinitions.mockImplementation(async () => rows);
    listVersions.mockImplementation(async () => rows.map(({ id, updatedAt }) => ({ id, updatedAt })));
    findDefinition.mockImplementation(async (_db, id) => byId.get(id) ?? null);

    await startTriggerScheduler();
    expect(cronMock.schedule).toHaveBeenCalledTimes(2);

    const edited = automation('a', t1);
    rows = [edited];
    byId.set('a', edited);
    byId.delete('b');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(cronMock.schedule).toHaveBeenCalledTimes(3);
    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    expect(tasks[1]?.stop).toHaveBeenCalledOnce();
  });

  it('dispatches a stable occurrence for a structured schedule', async () => {
    const definition = automation('automation-1', new Date('2026-09-02T00:00:00.000Z'));
    listDefinitions.mockResolvedValue([definition]);
    let callback: ((context: TaskContext) => Promise<void>) | undefined;
    cronMock.schedule.mockImplementation((_expression: string, run: (context: TaskContext) => Promise<void>) => {
      callback = run;
      return { stop: vi.fn() };
    });
    findDefinition.mockResolvedValue(definition);
    dispatchAutomation.mockResolvedValue({ status: 'observed' });

    await startTriggerScheduler();
    expect(cronMock.schedule).toHaveBeenCalledWith('0 9 * * 1', expect.any(Function), {
      timezone: 'UTC',
      noOverlap: true,
    });
    if (!callback) throw new Error('Expected cron callback');
    const occurredAt = new Date('2026-09-07T09:00:00.456Z');
    await callback({ date: occurredAt } as TaskContext);

    expect(dispatchAutomation).toHaveBeenCalledWith(definition, {
      kind: 'schedule',
      id: 'schedule:automation-1:2026-09-07T09:00:00.000Z',
      occurredAt: new Date('2026-09-07T09:00:00.000Z'),
    });
  });
});
