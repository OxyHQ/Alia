import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  activeAuthorizations: vi.fn(),
  createRun: vi.fn(),
  createSession: vi.fn(),
  disable: vi.fn(),
  enqueue: vi.fn(),
  enqueueAlia: vi.fn(),
  markAliaRun: vi.fn(),
  findAgent: vi.fn(),
  markRun: vi.fn(),
  notify: vi.fn(),
  observe: vi.fn(),
  oxyMap: vi.fn(),
  updateSession: vi.fn(),
  reserve: vi.fn(),
  refund: vi.fn(),
  aliaAuthorizations: vi.fn(),
  watchState: vi.fn(),
  watchObserve: vi.fn(),
  watchFailure: vi.fn(),
  watchPause: vi.fn(),
  watchRecord: vi.fn(),
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
  markAliaAutomationRun: state.markAliaRun,
  markAutomationRunForSession: state.markRun,
  setAutomationEnabled: state.disable,
}));
vi.mock('../../db/automation/aliaTaskAuthorityRepository.js', () => ({
  listActiveAliaTaskAuthorizations: state.aliaAuthorizations,
}));
vi.mock('../../db/automation/automationWatchRepository.js', () => ({
  findAutomationWatchState: state.watchState,
  recordAutomationWatchFailure: state.watchFailure,
  pauseFailingAutomationWatch: state.watchPause,
  recordAutomationWatchObservation: state.watchRecord,
}));
vi.mock('../alia-watch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../alia-watch.js')>()),
  observeWatchSource: state.watchObserve,
}));
vi.mock('../../db/agents/agentRepository.js', () => ({ findAgentById: state.findAgent }));
vi.mock('../../db/agents/agentSessionRepository.js', () => ({
  createAgentSession: state.createSession,
  updateAgentSession: state.updateSession,
}));
vi.mock('../tools/oxy-services.js', () => ({ getOxyAgentCapabilityMap: state.oxyMap }));
vi.mock('../task-queue.js', () => ({ enqueueAgentSession: state.enqueue }));
vi.mock('../alia-task-queue.js', () => ({ enqueueAliaTask: state.enqueueAlia }));
vi.mock('../notification-service.js', () => ({ sendNotification: state.notify }));
vi.mock('../credits-manager.js', () => ({
  reserveCredits: state.reserve,
  safeRefund: state.refund,
}));
vi.mock('../user-credits-helpers.js', () => ({
  getOrCreateUserCredits: vi.fn(async () => undefined),
}));
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

const manualTrigger = {
  kind: 'manual' as const,
  id: 'manual:automation-1:request-0001',
  occurredAt: new Date('2026-09-07T09:00:00.000Z'),
  requesterAccountId: 'owner-1',
};

const RESERVATION = { reservationId: 'hold-1', amount: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  state.reserve.mockResolvedValue(RESERVATION);
  database.transaction.mockImplementation(async (callback) => callback(database));
  state.findAgent.mockImplementation(async (_db, id: string) => ({
    id,
    ownerOxyAccountId: 'owner-1',
    access: 'private',
    applicationId: null,
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
  state.disable.mockResolvedValue({ id: 'automation-1', enabled: false });
  state.enqueue.mockResolvedValue(undefined);
  state.enqueueAlia.mockResolvedValue({ queued: true });
  state.markAliaRun.mockResolvedValue(undefined);
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
        {
          resource: inbox,
          maximumAutonomy: 'autonomous' as const,
          limits: [],
          toolNames: ['searchNotes'],
        },
        {
          resource: mention,
          maximumAutonomy: 'autonomous' as const,
          limits: [],
          toolNames: ['publishPost'],
        },
      ],
    };
    expect(candidateCoversResources(candidate, [inbox])).toBe(true);
    expect(candidateCoversAction(candidate, publishAction)).toBe(true);
    expect(
      planAutomationStages({ candidates: [candidate], sourceResources: [inbox], actions }),
    ).toEqual([expect.objectContaining({ agentId: 'agent-a', actions })]);
  });

  it('records observation with the deterministic actor plan and creates no session', async () => {
    await expect(dispatchStructuredAutomation(automation(), scheduleTrigger)).resolves.toEqual({
      status: 'observed',
    });
    expect(state.findAgent).toHaveBeenCalledTimes(2);
    expect(state.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: 'automation-1',
        triggerEventId: scheduleTrigger.id,
        stages: [expect.objectContaining({ selectedAgentId: 'agent-a' })],
      }),
    );
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it('records observation without requiring autonomous execution policy', async () => {
    state.oxyMap.mockResolvedValue([
      { resource: inbox, maximumAutonomy: 'draft', limits: [], toolNames: ['searchNotes'] },
      { resource: mention, maximumAutonomy: 'draft', limits: [], toolNames: ['publishPost'] },
    ]);
    await expect(
      dispatchStructuredAutomation(automation({ maximumAutonomy: 'draft' }), scheduleTrigger),
    ).resolves.toEqual({ status: 'observed' });
    expect(state.oxyMap).toHaveBeenCalledWith(expect.objectContaining({ autonomy: 'draft' }));
    expect(state.observe).toHaveBeenCalled();
  });

  it('does not select an unavailable agent', async () => {
    state.findAgent.mockImplementation(async (_db, id: string) => ({
      id,
      ownerOxyAccountId: 'owner-1',
      access: 'private',
      applicationId: null,
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

  it('never takes the listing author for the owner', async () => {
    // `author` is who published the listing; it grants nothing. An agent whose
    // only tie to the owner is that field is somebody else's private agent.
    state.findAgent.mockImplementation(async (_db, id: string) => ({
      id,
      author: 'owner-1',
      ownerOxyAccountId: 'someone-else',
      access: 'private',
      applicationId: null,
      oxyAccountId: `bot-${id}`,
      status: 'active',
    }));

    await expect(dispatchStructuredAutomation(automation(), scheduleTrigger)).resolves.toEqual({
      status: 'denied',
      reason: 'no_eligible_actor_plan',
    });
  });

  it('may run a public, active agent that somebody else owns', async () => {
    state.findAgent.mockImplementation(async (_db, id: string) => ({
      id,
      ownerOxyAccountId: 'someone-else',
      access: 'public',
      applicationId: null,
      oxyAccountId: `bot-${id}`,
      status: 'active',
    }));

    const result = await dispatchStructuredAutomation(automation(), scheduleTrigger);
    expect(result).not.toEqual({ status: 'denied', reason: 'no_eligible_actor_plan' });
  });

  it('queues an execute run only for an actor with live per-action authority', async () => {
    state.activeAuthorizations.mockResolvedValueOnce([
      { automationActionId: 'action-1', agentId: 'agent-b' },
    ]);
    await expect(
      dispatchStructuredAutomation(automation({ executionMode: 'execute' }), scheduleTrigger),
    ).resolves.toEqual({ status: 'queued', runId: expect.any(String), sessionId: 'session-1' });

    expect(state.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        db: database,
        automationId: 'automation-1',
        stages: [expect.objectContaining({ selectedAgentId: 'agent-b' })],
      }),
    );
    expect(state.createSession).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        agentId: 'agent-b',
        oxyUserId: 'owner-1',
        automationStage: 0,
        task: expect.stringContaining('"type":"schedule"'),
      }),
    );
    expect(state.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
  });

  it('queues an assistant-only scheduled task without fabricating Oxy authority', async () => {
    await expect(
      dispatchStructuredAutomation(
        automation({
          actorSelection: { mode: 'fixed', agentId: 'agent-a' },
          executionMode: 'execute',
          actions: [],
          resources: [],
          dataFlow: { sources: [], destinations: [] },
          inputs: { instructions: 'Remind me to call Alex' },
        }),
        scheduleTrigger,
      ),
    ).resolves.toEqual({ status: 'queued', runId: expect.any(String), sessionId: 'session-1' });

    expect(state.oxyMap).not.toHaveBeenCalled();
    expect(state.activeAuthorizations).not.toHaveBeenCalled();
    expect(state.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        stages: [expect.objectContaining({ actions: [] })],
      }),
    );
    expect(state.createSession).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        task: expect.stringContaining('has no connected-app effects'),
      }),
    );
  });

  it('disables a one-off task in the same transaction that claims its run', async () => {
    await dispatchStructuredAutomation(
      automation({
        actorSelection: { mode: 'fixed', agentId: 'agent-a' },
        executionMode: 'execute',
        actions: [],
        resources: [],
        dataFlow: { sources: [], destinations: [] },
        inputs: { instructions: 'Remind me tomorrow', runOnce: true },
      }),
      scheduleTrigger,
    );

    expect(state.disable).toHaveBeenCalledWith(database, 'automation-1', 'owner-1', false);
    expect(state.enqueue).toHaveBeenCalled();
  });

  it('runs an execute-on-request definition only for its owner and audits the requester', async () => {
    state.oxyMap.mockResolvedValueOnce([
      {
        resource: inbox,
        maximumAutonomy: 'execute_on_request',
        limits: [],
        toolNames: ['searchNotes'],
      },
      {
        resource: mention,
        maximumAutonomy: 'execute_on_request',
        limits: [],
        toolNames: ['publishPost'],
      },
    ]);

    await expect(
      dispatchStructuredAutomation(
        automation({
          executionMode: 'execute',
          maximumAutonomy: 'execute_on_request',
          trigger: { type: 'manual' },
        }),
        manualTrigger,
      ),
    ).resolves.toEqual({ status: 'queued', runId: expect.any(String), sessionId: 'session-1' });

    expect(state.oxyMap).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerAccountId: 'owner-1',
        autonomy: 'execute_on_request',
      }),
    );
    expect(state.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterAccountId: 'owner-1',
        triggerEventId: manualTrigger.id,
      }),
    );
    expect(state.createSession).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        task: expect.stringContaining('"type":"manual"'),
      }),
    );
  });

  it('does not execute a non-autonomous definition from a schedule', async () => {
    await expect(
      dispatchStructuredAutomation(
        automation({ executionMode: 'execute', maximumAutonomy: 'execute_on_request' }),
        scheduleTrigger,
      ),
    ).resolves.toEqual({
      status: 'denied',
      reason: 'background_execution_requires_autonomous_policy',
    });

    expect(state.oxyMap).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
  });

  it('does not treat a manual request as approval for a draft definition', async () => {
    await expect(
      dispatchStructuredAutomation(
        automation({
          executionMode: 'execute',
          maximumAutonomy: 'draft',
          trigger: { type: 'manual' },
        }),
        manualTrigger,
      ),
    ).resolves.toEqual({
      status: 'denied',
      reason: 'manual_execution_requires_request_autonomy',
    });

    expect(state.oxyMap).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
  });

  it('rejects a manual requester that does not own the definition', async () => {
    await expect(
      dispatchStructuredAutomation(automation(), {
        ...manualTrigger,
        requesterAccountId: 'other-owner',
      }),
    ).resolves.toEqual({ status: 'denied', reason: 'manual_requester_not_owner' });

    expect(state.findAgent).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
  });

  it('rejects a dispatch trigger that does not match the stored definition', async () => {
    await expect(dispatchStructuredAutomation(automation(), manualTrigger)).resolves.toEqual({
      status: 'denied',
      reason: 'automation_trigger_mismatch',
    });

    expect(state.findAgent).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
  });

  it('splits ordered actions between differently capable agents', async () => {
    const splitActions = [
      { ...publishAction, id: 'read-action', resource: inbox, tool: 'searchNotes', input: {} },
      { ...publishAction, id: 'publish-action' },
    ];
    state.oxyMap.mockImplementation(async (context) =>
      context.actor.accountId === 'bot-agent-a'
        ? [
            {
              resource: inbox,
              maximumAutonomy: 'autonomous',
              limits: [],
              toolNames: ['searchNotes'],
            },
          ]
        : [
            {
              resource: mention,
              maximumAutonomy: 'autonomous',
              limits: [],
              toolNames: ['publishPost'],
            },
          ],
    );
    state.activeAuthorizations.mockResolvedValue([
      { automationActionId: 'read-action', agentId: 'agent-a' },
      { automationActionId: 'publish-action', agentId: 'agent-b' },
    ]);

    await dispatchStructuredAutomation(
      automation({ executionMode: 'execute', actions: splitActions }),
      scheduleTrigger,
    );

    expect(state.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        stages: [
          expect.objectContaining({
            stage: 0,
            selectedAgentId: 'agent-a',
            actions: [splitActions[0]],
          }),
          expect.objectContaining({
            stage: 1,
            selectedAgentId: 'agent-b',
            actions: [splitActions[1]],
          }),
        ],
      }),
    );
  });

  it('creates no session when another worker already claimed the occurrence', async () => {
    state.createRun.mockResolvedValueOnce(false);
    await expect(
      dispatchStructuredAutomation(automation({ executionMode: 'execute' }), scheduleTrigger),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
    // The hold taken before the claim is given back: nothing will settle it.
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'duplicate automation run');
  });

  it('holds credits for the run and hands the hold to the session the runner settles', async () => {
    await dispatchStructuredAutomation(automation({ executionMode: 'execute' }), scheduleTrigger);

    expect(state.reserve).toHaveBeenCalledWith('owner-1');
    expect(state.createSession).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        creditReservation: RESERVATION,
      }),
    );
  });

  it('does not run, and says why, when the owner cannot cover the hold', async () => {
    state.reserve.mockResolvedValueOnce(null);

    await expect(
      dispatchStructuredAutomation(automation({ executionMode: 'execute' }), scheduleTrigger),
    ).resolves.toEqual({ status: 'denied', reason: 'insufficient_credits' });
    expect(state.createRun).not.toHaveBeenCalled();
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.notify).toHaveBeenCalled();
  });
});

describe('a task Alia is responsible for', () => {
  const aliaTask = (overrides: Record<string, unknown> = {}) =>
    automation({
      objective: 'Track the latest releases from Meta',
      actorSelection: { mode: 'alia' },
      executionMode: 'execute',
      actions: [],
      resources: [],
      dataFlow: { sources: [], destinations: [] },
      inputs: { instructions: 'Tell me when Meta announces something new' },
      ...overrides,
    });

  it('claims the run with Alia as its actor and queues an Alia job, not an agent session', async () => {
    const result = await dispatchStructuredAutomation(aliaTask(), scheduleTrigger);

    expect(result).toEqual({ status: 'queued', runId: expect.any(String) });
    const runId = (result as { runId: string }).runId;
    expect(state.findAgent).not.toHaveBeenCalled();
    expect(state.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        db: database,
        runId,
        automationId: 'automation-1',
        requesterAccountId: 'owner-1',
        triggerEventId: scheduleTrigger.id,
        actorType: 'alia',
        stages: [
          expect.objectContaining({
            selectedAgentId: null,
            selectedActorAccountId: 'owner-1',
            actions: [],
            taskInput: expect.objectContaining({
              objective: 'Track the latest releases from Meta',
            }),
          }),
        ],
      }),
    );
    expect(state.enqueueAlia).toHaveBeenCalledWith({
      runId,
      automationId: 'automation-1',
      userId: 'owner-1',
      creditReservation: RESERVATION,
    });
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it('records an observed run under Alia without holding credits', async () => {
    await expect(
      dispatchStructuredAutomation(aliaTask({ executionMode: 'observe' }), scheduleTrigger),
    ).resolves.toEqual({ status: 'observed' });

    expect(state.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'alia',
        stages: [expect.objectContaining({ selectedAgentId: null })],
      }),
    );
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.enqueueAlia).not.toHaveBeenCalled();
  });

  it('disables a one-off Alia task in the transaction that claims its run', async () => {
    await dispatchStructuredAutomation(
      aliaTask({ inputs: { instructions: 'Remind me', runOnce: true } }),
      scheduleTrigger,
    );

    expect(state.disable).toHaveBeenCalledWith(database, 'automation-1', 'owner-1', false);
    expect(state.enqueueAlia).toHaveBeenCalled();
  });

  it('gives the hold back and queues nothing for a duplicate occurrence', async () => {
    state.createRun.mockResolvedValueOnce(false);

    await expect(dispatchStructuredAutomation(aliaTask(), scheduleTrigger)).resolves.toEqual({
      status: 'duplicate',
    });
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'duplicate automation run');
    expect(state.enqueueAlia).not.toHaveBeenCalled();
  });

  it('fails the run and refunds when the job cannot be queued', async () => {
    state.enqueueAlia.mockRejectedValueOnce(new Error('redis down'));

    await expect(dispatchStructuredAutomation(aliaTask(), scheduleTrigger)).rejects.toThrow(
      'redis down',
    );
    expect(state.markAliaRun).toHaveBeenCalledWith(database, expect.any(String), 'failed');
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'automation run could not be queued');
  });

  it('runs declared connected actions herself under her standing authority', async () => {
    state.aliaAuthorizations.mockResolvedValueOnce([
      { automationActionId: null, oxyAuthorizationId: 'oxy-read' },
      { automationActionId: 'action-1', oxyAuthorizationId: 'oxy-publish' },
    ]);

    const result = await dispatchStructuredAutomation(aliaTask({ actions }), scheduleTrigger);
    expect(result).toEqual({ status: 'queued', runId: expect.any(String) });
    expect(state.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'alia',
        creditReservation: RESERVATION,
        stages: [
          expect.objectContaining({
            selectedAgentId: null,
            actions: [expect.objectContaining({ id: 'action-1', tool: 'publishPost' })],
          }),
        ],
      }),
    );
  });

  it('runs nothing when a declared action lost its authority', async () => {
    state.aliaAuthorizations.mockResolvedValueOnce([
      { automationActionId: null, oxyAuthorizationId: 'oxy-read' },
    ]);

    await expect(
      dispatchStructuredAutomation(aliaTask({ actions }), scheduleTrigger),
    ).resolves.toEqual({
      status: 'denied',
      reason: 'alia_action_authority_missing',
    });
    expect(state.createRun).not.toHaveBeenCalled();
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.notify).toHaveBeenCalled();
  });
});

describe('a watch task', () => {
  const watchTask = (watch: Record<string, unknown> = { query: 'Meta announcement' }) =>
    automation({
      objective: 'Tell me when Meta announces something new',
      actorSelection: { mode: 'alia' },
      executionMode: 'execute',
      actions: [],
      resources: [],
      dataFlow: { sources: [], destinations: [] },
      inputs: { watch },
    });
  const observation = (items: string[], text = 'Meta news') => ({
    hash: `hash-${items.join(',')}`,
    items,
    text,
    results: items.map((url) => ({ title: `Title ${url}`, url, snippet: 'snippet' })),
  });

  beforeEach(() => {
    state.watchState.mockResolvedValue({
      lastHash: 'hash-a',
      lastItems: ['a'],
      matched: false,
      nextCheckAt: null,
    });
    state.watchFailure.mockResolvedValue(1);
    state.watchPause.mockResolvedValue(true);
    state.watchRecord.mockResolvedValue(undefined);
  });

  it('a tick that sees nothing new costs nothing and starts no run', async () => {
    state.watchObserve.mockResolvedValueOnce(observation(['a']));

    await expect(dispatchStructuredAutomation(watchTask(), scheduleTrigger)).resolves.toEqual({
      status: 'unchanged',
    });
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
    expect(state.watchRecord).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        automationId: 'automation-1',
        hash: 'hash-a',
        changed: false,
      }),
    );
  });

  it('the first good tick is a baseline, not news', async () => {
    state.watchState.mockResolvedValueOnce(null);
    state.watchObserve.mockResolvedValueOnce(observation(['a', 'b']));

    await expect(dispatchStructuredAutomation(watchTask(), scheduleTrigger)).resolves.toEqual({
      status: 'unchanged',
    });
    expect(state.reserve).not.toHaveBeenCalled();
  });

  it('a new result starts one Alia run keyed by the observation, with the change attached', async () => {
    state.watchObserve.mockResolvedValueOnce(observation(['a', 'b']));

    const result = await dispatchStructuredAutomation(watchTask(), scheduleTrigger);
    expect(result).toEqual({ status: 'queued', runId: expect.any(String) });
    expect(state.reserve).toHaveBeenCalledTimes(1);
    expect(state.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerEventId: 'watch:automation-1:hash-a,b',
        stages: [
          expect.objectContaining({
            taskInput: expect.objectContaining({
              trigger: expect.objectContaining({
                watch: expect.objectContaining({
                  source: { query: 'Meta announcement' },
                  newResults: [expect.objectContaining({ url: 'b' })],
                }),
              }),
            }),
          }),
        ],
      }),
    );
    expect(state.watchRecord).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ hash: 'hash-a,b', changed: true }),
    );
  });

  it('a duplicate observation is recorded but runs nothing twice', async () => {
    state.watchObserve.mockResolvedValueOnce(observation(['a', 'b']));
    state.createRun.mockResolvedValueOnce(false);

    await expect(dispatchStructuredAutomation(watchTask(), scheduleTrigger)).resolves.toEqual({
      status: 'duplicate',
    });
    expect(state.enqueueAlia).not.toHaveBeenCalled();
    expect(state.watchRecord).toHaveBeenCalled();
  });

  it('keeps the change for the next tick when the run cannot be paid for', async () => {
    state.watchObserve.mockResolvedValueOnce(observation(['a', 'b']));
    state.reserve.mockResolvedValueOnce(null);

    await expect(dispatchStructuredAutomation(watchTask(), scheduleTrigger)).resolves.toEqual({
      status: 'denied',
      reason: 'insufficient_credits',
    });
    expect(state.watchRecord).not.toHaveBeenCalled();
  });

  it('fires a contains watch on the rising edge only', async () => {
    state.watchState.mockResolvedValueOnce(null);
    state.watchObserve.mockResolvedValueOnce(observation([], 'Now available: Llama 5'));
    await expect(
      dispatchStructuredAutomation(
        watchTask({ url: 'https://example.com/news', condition: 'contains', value: 'llama 5' }),
        scheduleTrigger,
      ),
    ).resolves.toEqual({ status: 'queued', runId: expect.any(String) });

    state.watchState.mockResolvedValueOnce({
      lastHash: 'x',
      lastItems: [],
      matched: true,
      nextCheckAt: null,
    });
    state.watchObserve.mockResolvedValueOnce(observation([], 'Now available: Llama 5 and more'));
    await expect(
      dispatchStructuredAutomation(
        watchTask({ url: 'https://example.com/news', condition: 'contains', value: 'llama 5' }),
        scheduleTrigger,
      ),
    ).resolves.toEqual({ status: 'unchanged' });
  });

  it('skips the tick while backing off after a failure', async () => {
    state.watchState.mockResolvedValueOnce({
      lastHash: 'hash-a',
      lastItems: ['a'],
      matched: false,
      nextCheckAt: new Date(Date.now() + 60_000),
    });

    await expect(dispatchStructuredAutomation(watchTask(), scheduleTrigger)).resolves.toEqual({
      status: 'denied',
      reason: 'watch_backing_off',
    });
    expect(state.watchObserve).not.toHaveBeenCalled();
  });

  it('records a failed tick without notifying', async () => {
    state.watchObserve.mockRejectedValueOnce(new Error('clarity down'));
    state.watchFailure.mockResolvedValueOnce(2);

    await expect(dispatchStructuredAutomation(watchTask(), scheduleTrigger)).resolves.toEqual({
      status: 'denied',
      reason: 'watch_source_failed',
    });
    expect(state.watchPause).not.toHaveBeenCalled();
    expect(state.notify).not.toHaveBeenCalled();
  });

  it('pauses after five failures in a row and says so once', async () => {
    state.watchObserve.mockRejectedValue(new Error('clarity down'));
    state.watchFailure.mockResolvedValue(5);
    state.watchPause.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(dispatchStructuredAutomation(watchTask(), scheduleTrigger)).resolves.toEqual({
      status: 'denied',
      reason: 'watch_paused',
    });
    await expect(dispatchStructuredAutomation(watchTask(), scheduleTrigger)).resolves.toEqual({
      status: 'denied',
      reason: 'watch_source_failed',
    });
    expect(state.watchPause).toHaveBeenCalledWith(database, 'automation-1', 5, expect.any(Date));
    expect(state.notify).toHaveBeenCalledTimes(1);
    state.watchObserve.mockReset();
  });
});
