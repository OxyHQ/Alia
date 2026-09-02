import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  coverage: vi.fn(),
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

const database = { kind: 'test-db' };

vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  automationHasActiveAuthorizationCoverage: state.coverage,
  createAutomationRunForSession: state.createRun,
  createObservedAutomationRun: state.observe,
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

import {
  assignmentsCoverAutomation,
  dispatchStructuredAutomation,
} from '../automation-dispatcher.js';

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
const actions = [{
  id: 'action-1',
  position: 0,
  resource: mention,
  tool: 'publishPost',
  input: { text: 'Weekly summary' },
  limits: [],
}];

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
  state.findAgent.mockImplementation(async (_db, id: string) => ({
    id,
    author: 'owner-1',
    oxyAccountId: `bot-${id}`,
  }));
  state.oxyMap.mockResolvedValue([
    { resource: inbox, maximumAutonomy: 'autonomous', toolNames: ['searchNotes'] },
    { resource: mention, maximumAutonomy: 'autonomous', toolNames: ['publishPost'] },
  ]);
  state.coverage.mockResolvedValue(true);
  state.observe.mockResolvedValue(true);
  state.createSession.mockResolvedValue({ id: 'session-1' });
  state.createRun.mockResolvedValue(true);
  state.enqueue.mockResolvedValue(undefined);
  state.updateSession.mockResolvedValue(undefined);
  state.markRun.mockResolvedValue(undefined);
  state.notify.mockResolvedValue(undefined);
});

describe('normalized automation dispatch', () => {
  it('requires one capability map to cover every source and declared action', () => {
    const assignments = [
      { resource: inbox, maximumAutonomy: 'autonomous' as const, toolNames: ['searchNotes'] },
      { resource: mention, maximumAutonomy: 'autonomous' as const, toolNames: ['publishPost'] },
    ];
    expect(assignmentsCoverAutomation({ assignments, sourceResources: [inbox], actions })).toBe(true);
    expect(assignmentsCoverAutomation({
      assignments: assignments.slice(0, 1),
      sourceResources: [inbox],
      actions,
    })).toBe(false);
  });

  it('records observation with the first eligible agent and creates no session', async () => {
    await expect(dispatchStructuredAutomation(automation(), scheduleTrigger)).resolves.toEqual({
      status: 'observed',
    });
    expect(state.findAgent).toHaveBeenCalledTimes(1);
    expect(state.findAgent).toHaveBeenCalledWith(database, 'agent-a');
    expect(state.observe).toHaveBeenCalledWith(expect.objectContaining({
      automationId: 'automation-1',
      selectedAgentId: 'agent-a',
      triggerEventId: scheduleTrigger.id,
    }));
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it('queues an execute run only after durable action coverage is live', async () => {
    state.coverage.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(dispatchStructuredAutomation(
      automation({ executionMode: 'execute' }),
      scheduleTrigger,
    )).resolves.toEqual({ status: 'queued', sessionId: 'session-1' });

    expect(state.coverage).toHaveBeenNthCalledWith(
      1,
      database,
      'automation-1',
      'agent-a',
      ['action-1'],
    );
    expect(state.coverage).toHaveBeenNthCalledWith(
      2,
      database,
      'automation-1',
      'agent-b',
      ['action-1'],
    );
    expect(state.createSession).toHaveBeenCalledWith(database, expect.objectContaining({
      agentId: 'agent-b',
      oxyUserId: 'owner-1',
      task: expect.stringContaining('"type":"schedule"'),
    }));
    expect(state.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
  });

  it('cancels the unqueued session when another worker claimed the occurrence', async () => {
    state.createRun.mockResolvedValueOnce(false);
    await expect(dispatchStructuredAutomation(
      automation({ executionMode: 'execute' }),
      scheduleTrigger,
    )).resolves.toEqual({ status: 'duplicate' });
    expect(state.updateSession).toHaveBeenCalledWith(database, 'session-1', expect.objectContaining({
      status: 'cancelled',
    }));
    expect(state.enqueue).not.toHaveBeenCalled();
  });
});
