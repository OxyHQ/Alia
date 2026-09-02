import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  activeAuthorizations: vi.fn(),
  createRun: vi.fn(),
  createSession: vi.fn(),
  enqueue: vi.fn(),
  findAgent: vi.fn(),
  markRun: vi.fn(),
  notify: vi.fn(),
  observe: vi.fn(),
  oxyMap: vi.fn(),
  updateSession: vi.fn(),
}));

const database = {
  kind: 'test-db',
  transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => callback(database)),
};

vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  claimAutomationRunPlan: state.createRun,
  createObservedAutomationRun: state.observe,
  listActiveAutomationAuthorizations: state.activeAuthorizations,
  markAutomationRunForSession: state.markRun,
}));
vi.mock('../../db/agents/agentRepository.js', () => ({ findAgentById: state.findAgent }));
vi.mock('../../db/agents/agentSessionRepository.js', () => ({
  createAgentSession: state.createSession,
  updateAgentSession: state.updateSession,
}));
vi.mock('../tools/oxy-services.js', () => ({ getOxyAgentCapabilityMap: state.oxyMap }));
vi.mock('../task-queue.js', () => ({ enqueueAgentSession: state.enqueue }));
vi.mock('../notification-service.js', () => ({ sendNotification: state.notify }));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { triggers: child } };
});

import { dispatchStructuredAutomation } from '../automation-dispatcher.js';
import {
  candidateCoversAction,
  candidateCoversResources,
  planAutomationStages,
} from '../automation-coordination.js';

const inbox = {
  appId: 'inbox',
  effectiveAccountId: 'owner-1',
  resourceType: 'mailbox',
  resourceId: 'mailbox-1',
};
const mention = {
  appId: 'mention',
  effectiveAccountId: 'owner-1',
  resourceType: 'social_account',
  resourceId: 'profile-1',
};
const publishAction = {
  id: 'action-1',
  position: 0,
  resource: mention,
  tool: 'publishPost',
  input: { text: 'Weekly summary' },
  limits: [],
};
const actions = [publishAction];

function automation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'automation-1',
    ownerAccountId: 'owner-1',
    objective: 'Publish the weekly summary',
    trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
    actorSelection: { mode: 'automatic', eligibleAgentIds: ['agent-a', 'agent-b'] },
    executionMode: 'observe',
    actions,
    inputs: { style: 'brief' },
    resources: [inbox, mention],
    dataFlow: { sources: [inbox], destinations: [mention] },
    maximumAutonomy: 'autonomous',
    limits: [],
    enabled: true,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  } as never;
}

const scheduleTrigger = {
  kind: 'schedule' as const,
  id: 'schedule:automation-1:2026-09-07T09:00:00.000Z',
  occurredAt: new Date('2026-09-07T09:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  database.transaction.mockImplementation(async (callback) => callback(database));
  state.findAgent.mockImplementation(async (_db, id: string) => ({
    id,
    author: 'owner-1',
    oxyAccountId: `bot-${id}`,
    status: 'active',
  }));
  state.oxyMap.mockResolvedValue([
    { resource: inbox, maximumAutonomy: 'autonomous', limits: [], toolNames: ['searchNotes'] },
    { resource: mention, maximumAutonomy: 'autonomous', limits: [], toolNames: ['publishPost'] },
  ]);
  state.activeAuthorizations.mockResolvedValue([
    { automationActionId: 'action-1', agentId: 'agent-a' },
  ]);
  state.observe.mockResolvedValue(true);
  state.createSession.mockImplementation(async (_db, input) => ({ id: 'session-1', ...input }));
  state.createRun.mockResolvedValue(true);
  state.enqueue.mockResolvedValue(undefined);
  state.updateSession.mockResolvedValue(undefined);
  state.markRun.mockResolvedValue(undefined);
  state.notify.mockResolvedValue(undefined);
});

describe('normalized automation dispatch', () => {
  it('evaluates source and action coverage without reading app content', () => {
    const candidate = {
      agentId: 'agent-a',
      actorAccountId: 'bot-agent-a',
      assignments: [
        { resource: inbox, maximumAutonomy: 'autonomous' as const, limits: [], toolNames: ['searchNotes'] },
        { resource: mention, maximumAutonomy: 'autonomous' as const, limits: [], toolNames: ['publishPost'] },
      ],
    };
    expect(candidateCoversResources(candidate, [inbox])).toBe(true);
    expect(candidateCoversAction(candidate, publishAction)).toBe(true);
    expect(planAutomationStages({ candidates: [candidate], sourceResources: [inbox], actions }))
      .toEqual([expect.objectContaining({ agentId: 'agent-a', actions })]);
  });

  it('records observation with the deterministic actor plan and creates no session', async () => {
    await expect(dispatchStructuredAutomation(automation(), scheduleTrigger)).resolves.toEqual({
      status: 'observed',
    });
    expect(state.findAgent).toHaveBeenCalledTimes(2);
    expect(state.observe).toHaveBeenCalledWith(expect.objectContaining({
      automationId: 'automation-1',
      triggerEventId: scheduleTrigger.id,
      stages: [expect.objectContaining({ selectedAgentId: 'agent-a' })],
    }));
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it('does not select an unavailable agent', async () => {
    state.findAgent.mockImplementation(async (_db, id: string) => ({
      id,
      author: 'owner-1',
      oxyAccountId: `bot-${id}`,
      status: 'offline',
    }));

    await expect(dispatchStructuredAutomation(automation(), scheduleTrigger)).resolves.toEqual({
      status: 'denied',
      reason: 'no_eligible_actor_plan',
    });
    expect(state.oxyMap).not.toHaveBeenCalled();
    expect(state.observe).not.toHaveBeenCalled();
  });

  it('queues an execute run only for an actor with live per-action authority', async () => {
    state.activeAuthorizations.mockResolvedValueOnce([
      { automationActionId: 'action-1', agentId: 'agent-b' },
    ]);
    await expect(dispatchStructuredAutomation(
      automation({ executionMode: 'execute' }),
      scheduleTrigger,
    )).resolves.toEqual({ status: 'queued', sessionId: 'session-1' });

    expect(state.createRun).toHaveBeenCalledWith(expect.objectContaining({
      db: database,
      automationId: 'automation-1',
      stages: [expect.objectContaining({ selectedAgentId: 'agent-b' })],
    }));
    expect(state.createSession).toHaveBeenCalledWith(database, expect.objectContaining({
      agentId: 'agent-b',
      oxyUserId: 'owner-1',
      automationStage: 0,
      task: expect.stringContaining('"type":"schedule"'),
    }));
    expect(state.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
  });

  it('splits ordered actions between differently capable agents', async () => {
    const splitActions = [
      { ...publishAction, id: 'read-action', resource: inbox, tool: 'searchNotes', input: {} },
      { ...publishAction, id: 'publish-action' },
    ];
    state.oxyMap.mockImplementation(async (context) => context.actor.accountId === 'bot-agent-a'
      ? [{ resource: inbox, maximumAutonomy: 'autonomous', limits: [], toolNames: ['searchNotes'] }]
      : [{ resource: mention, maximumAutonomy: 'autonomous', limits: [], toolNames: ['publishPost'] }]);
    state.activeAuthorizations.mockResolvedValue([
      { automationActionId: 'read-action', agentId: 'agent-a' },
      { automationActionId: 'publish-action', agentId: 'agent-b' },
    ]);

    await dispatchStructuredAutomation(automation({ executionMode: 'execute', actions: splitActions }), scheduleTrigger);

    expect(state.createRun).toHaveBeenCalledWith(expect.objectContaining({
      stages: [
        expect.objectContaining({ stage: 0, selectedAgentId: 'agent-a', actions: [splitActions[0]] }),
        expect.objectContaining({ stage: 1, selectedAgentId: 'agent-b', actions: [splitActions[1]] }),
      ],
    }));
  });

  it('creates no session when another worker already claimed the occurrence', async () => {
    state.createRun.mockResolvedValueOnce(false);
    await expect(dispatchStructuredAutomation(
      automation({ executionMode: 'execute' }),
      scheduleTrigger,
    )).resolves.toEqual({ status: 'duplicate' });
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
  });
});
