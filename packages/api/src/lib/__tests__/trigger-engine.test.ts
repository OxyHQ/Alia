import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Standalone Mongo has no change streams, so trigger-engine reconciles the
// in-memory cron registry against the DB on a timer. This suite exercises that
// reconcile loop; every heavy collaborator of trigger-engine is stubbed so the
// module imports cheaply and only the scheduling bookkeeping is under test.

vi.mock('mongoose', () => ({ default: { connection: { db: undefined, collection: vi.fn() } } }));
vi.mock('node-cron', () => ({ default: { schedule: vi.fn(), validate: vi.fn(() => true) } }));
vi.mock('ai', () => ({ generateText: vi.fn(), stepCountIs: vi.fn() }));
vi.mock('../chat-core.js', () => ({ resolveModel: vi.fn(), getAIModel: vi.fn(), getDefaultAliaModel: vi.fn() }));
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
vi.mock('../notification-service.js', () => ({ sendNotification: vi.fn() }));
vi.mock('../errors/index.js', () => ({ getErrorMessage: vi.fn((e: unknown) => String(e)) }));
vi.mock('../agent/archetype-prompts.js', () => ({ buildArchetypeSystemPrompt: vi.fn() }));
vi.mock('../agent/routing-handler.js', () => ({ handleRoutingDecision: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({ oxyClient: { getUserById: vi.fn() } }));
vi.mock('../../models/user-memory.js', () => ({ UserMemory: { findOne: vi.fn() } }));
vi.mock('../../models/trigger-execution.js', () => ({ TriggerExecution: { create: vi.fn(), findOne: vi.fn() } }));
vi.mock('../../models/agent.js', () => ({ Agent: { find: vi.fn() } }));
vi.mock('../../models/trigger.js', () => ({ Trigger: { find: vi.fn(), findById: vi.fn() } }));
vi.mock('../logger.js', () => ({
  log: {
    triggers: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { Trigger } from '../../models/trigger.js';
import { Agent } from '../../models/agent.js';
import cron from 'node-cron';

type MockFn = ReturnType<typeof vi.fn>;
const triggerModel = Trigger as unknown as { find: MockFn; findById: MockFn };
const agentModel = Agent as unknown as { find: MockFn };
const cronMock = cron as unknown as { schedule: MockFn; validate: MockFn };

interface FakeTrigger {
  _id: { toString(): string };
  name: string;
  enabled: boolean;
  type: string;
  schedule: { type: string; intervalMinutes: number };
  updatedAt: Date;
}

// A Mongoose-Query-like value: awaitable (for the scheduler's `await find(...)`)
// and chainable via `.select().lean()` (for the reconcile query).
function makeQuery<T>(result: T) {
  return {
    select: () => ({ lean: () => Promise.resolve(result) }),
    then: (onFulfilled?: ((v: T) => unknown) | null, onRejected?: ((e: unknown) => unknown) | null) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };
}

const trig = (id: string, updatedAt: Date): FakeTrigger => ({
  _id: { toString: () => id },
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
    agentModel.find.mockReturnValue(makeQuery([]));
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
    triggerModel.find.mockImplementation(() => makeQuery(rows));
    triggerModel.findById.mockImplementation((id: string) => Promise.resolve(byId.get(String(id)) ?? null));

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
});
