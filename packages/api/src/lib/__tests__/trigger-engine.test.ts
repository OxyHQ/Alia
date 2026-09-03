import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The trigger engine reconciles its in-memory cron registry against PostgreSQL
// on a timer. This suite exercises that loop; every heavy collaborator is
// stubbed so the module imports cheaply and only the scheduling bookkeeping is
// under test.

vi.mock('node-cron', () => ({ default: { schedule: vi.fn(), validate: vi.fn(() => true) } }));
vi.mock('ai', () => ({ generateText: vi.fn(), stepCountIs: vi.fn() }));
vi.mock('../chat-core.js', () => ({ resolveModel: vi.fn(), getAIModel: vi.fn(), getDefaultRoutingProfile: vi.fn() }));
vi.mock('../tools/index.js', () => ({
  getCurrentDateTool: {},
  webSearchTool: {},
  browseTool: {},
  webScraperTool: {},
  saveUserMemoryTool: vi.fn(),
  updateUserPreferencesTool: vi.fn(),
  updateUserContextTool: vi.fn(),
  createSendTelegramTool: vi.fn(),
}));
vi.mock('../tools/integrations.js', () => ({ buildIntegrationTools: vi.fn() }));
vi.mock('../tools/mcp.js', () => ({ buildMcpTools: vi.fn() }));
// Tool assembly moved out of the trigger engine into the ONE assembler, and
// the real one imports every tool module. This file's subject is the
// reconcile loop, so the assembler is a stub — the same role
// `../tools/index.js` above already plays for the individual tools.
vi.mock('../tool-pipeline.js', () => ({
  ToolPipeline: { forUser: vi.fn(async () => ({ tools: {}, toolNameMapping: new Map() })) },
}));
vi.mock('../notification-service.js', () => ({ sendNotification: vi.fn() }));
vi.mock('../errors/index.js', () => ({ getErrorMessage: vi.fn((e: unknown) => String(e)) }));
vi.mock('../agent/archetype-prompts.js', () => ({ buildArchetypeSystemPrompt: vi.fn() }));
vi.mock('../agent/routing-handler.js', () => ({ handleRoutingDecision: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({ oxyClient: { getUserById: vi.fn() } }));
vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  beginLegacyTriggerAutomationRun: vi.fn(async () => true),
  findAutomationDefinitionById: vi.fn(),
  listSchedulableAutomationDefinitions: vi.fn(async () => []),
  listSchedulableAutomationVersions: vi.fn(async () => []),
  markAutomationRunForSession: vi.fn(async () => undefined),
}));
vi.mock('../automation-dispatcher.js', () => ({ dispatchStructuredAutomation: vi.fn() }));
vi.mock('../../db/memory/userMemoryRepository.js', () => ({ findUserMemory: vi.fn() }));
vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: vi.fn(async () => null),
  listAgentsWithHeartbeat: vi.fn(async () => []),
}));
// The engine reads triggers through the repository now, so THAT is what is
// stubbed. A `vi.mock` specifier is a plain string that neither tsc nor vitest
// checks against a real module, so a stale path here would silently stub
// nothing and the reconcile loop would try to reach Postgres.
vi.mock('../../db/automation/triggerRepository.js', () => ({
  findSchedulableTriggers: vi.fn(),
  listSchedulableTriggerVersions: vi.fn(),
  findTriggerById: vi.fn(),
  findAgentHeartbeatTrigger: vi.fn(),
  findIntegrationEventTriggers: vi.fn(),
  findTriggerByWebhookToken: vi.fn(),
  findLastSuccessfulExecution: vi.fn(),
  claimTriggerForRun: vi.fn(),
  completeTriggerExecution: vi.fn(),
  createTrigger: vi.fn(),
  createTriggerExecution: vi.fn(),
  recordTriggerSuccess: vi.fn(),
  recordTriggerFailure: vi.fn(),
  setTriggerSchedule: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  log: {
    triggers: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import {
  findSchedulableTriggers,
  findTriggerById,
  listSchedulableTriggerVersions,
} from '../../db/automation/triggerRepository.js';
import {
  findAutomationDefinitionById,
  listSchedulableAutomationDefinitions,
  listSchedulableAutomationVersions,
} from '../../db/automation/automationDefinitionRepository.js';
import { listAgentsWithHeartbeat } from '../../db/agents/agentRepository.js';
import { dispatchStructuredAutomation } from '../automation-dispatcher.js';
import cron from 'node-cron';

type MockFn = ReturnType<typeof vi.fn>;
const schedulable = findSchedulableTriggers as unknown as MockFn;
const versions = listSchedulableTriggerVersions as unknown as MockFn;
const byIdFn = findTriggerById as unknown as MockFn;
const heartbeatAgents = listAgentsWithHeartbeat as unknown as MockFn;
const schedulableAutomations = listSchedulableAutomationDefinitions as unknown as MockFn;
const automationVersions = listSchedulableAutomationVersions as unknown as MockFn;
const automationById = findAutomationDefinitionById as unknown as MockFn;
const dispatchAutomation = dispatchStructuredAutomation as unknown as MockFn;
const cronMock = cron as unknown as { schedule: MockFn; validate: MockFn };

interface FakeTrigger {
  _id: string;
  name: string;
  enabled: boolean;
  type: string;
  schedule: { type: string; intervalMinutes: number };
  updatedAt: Date;
}

const trig = (id: string, updatedAt: Date): FakeTrigger => ({
  _id: id,
  name: `trigger-${id}`,
  enabled: true,
  type: 'schedule',
  schedule: { type: 'interval', intervalMinutes: 5 },
  updatedAt,
});

describe('trigger-engine reconcile loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cronMock.validate.mockReturnValue(true);
    // The heartbeat sync runs at startup and is not what this file measures.
    heartbeatAgents.mockResolvedValue([]);
    schedulableAutomations.mockResolvedValue([]);
    automationVersions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reschedules an edited trigger and stops a removed one', async () => {
    vi.useFakeTimers();
    const { startTriggerScheduler, stopAllScheduledTasks } = await import('../trigger-engine.js');

    const t0 = new Date('2026-07-15T00:00:00.000Z');
    const t1 = new Date('2026-07-15T01:00:00.000Z');

    const tasks: Array<{ stop: MockFn }> = [];
    cronMock.schedule.mockImplementation(() => {
      const task = { stop: vi.fn() };
      tasks.push(task);
      return task;
    });

    // Initial load: two enabled schedule triggers.
    let rows: FakeTrigger[] = [trig('a', t0), trig('b', t0)];
    const byId = new Map<string, FakeTrigger>([['a', rows[0]], ['b', rows[1]]]);
    schedulable.mockImplementation(() => Promise.resolve(rows));
    // The reconcile loop reads only `(id, updatedAt)`, then re-reads in full.
    versions.mockImplementation(() =>
      Promise.resolve(rows.map((r) => ({ id: r._id, updatedAt: r.updatedAt }))),
    );
    byIdFn.mockImplementation((_db: unknown, id: string) =>
      Promise.resolve(byId.get(String(id)) ?? undefined),
    );

    await startTriggerScheduler();
    expect(cronMock.schedule).toHaveBeenCalledTimes(2);

    // Edit 'a' (newer updatedAt) and delete 'b'.
    const editedA = trig('a', t1);
    rows = [editedA];
    byId.set('a', editedA);
    byId.delete('b');

    // Fire the 30s reconcile tick.
    await vi.advanceTimersByTimeAsync(30_000);

    // 'a' is rescheduled in place (old cron task stopped, a new one created);
    // 'b' has disappeared from the DB so its cron task is stopped.
    expect(cronMock.schedule).toHaveBeenCalledTimes(3);
    expect(tasks[0].stop).toHaveBeenCalled();
    expect(tasks[1].stop).toHaveBeenCalled();

    stopAllScheduledTasks();
  });

  it('runs normalized schedules through the same elected cron engine', async () => {
    const { startTriggerScheduler, stopAllScheduledTasks } = await import('../trigger-engine.js');
    const automation = {
      id: 'automation-1',
      ownerAccountId: 'owner-1',
      objective: 'Weekly summary',
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
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    };
    schedulable.mockResolvedValue([]);
    versions.mockResolvedValue([]);
    schedulableAutomations.mockResolvedValue([automation]);
    automationVersions.mockResolvedValue([{ id: automation.id, updatedAt: automation.updatedAt }]);
    automationById.mockResolvedValue(automation);
    dispatchAutomation.mockResolvedValue({ status: 'observed' });
    let callback: ((context: { date: Date }) => Promise<void>) | undefined;
    cronMock.schedule.mockImplementation((_expression: string, run: (context: { date: Date }) => Promise<void>) => {
      callback = run;
      return { stop: vi.fn() };
    });

    await startTriggerScheduler();
    expect(cronMock.schedule).toHaveBeenCalledWith('0 9 * * 1', expect.any(Function), {
      timezone: 'UTC',
      noOverlap: true,
    });
    const occurredAt = new Date('2026-09-07T09:00:00.456Z');
    await callback?.({ date: occurredAt });
    expect(dispatchAutomation).toHaveBeenCalledWith(automation, {
      kind: 'schedule',
      id: 'schedule:automation-1:2026-09-07T09:00:00.000Z',
      occurredAt: new Date('2026-09-07T09:00:00.000Z'),
    });
    stopAllScheduledTasks();
  });
});
