import { uuidv7 } from '@oxyhq/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  automationHasActiveAuthorizationCoverage,
  automationRunProgressForSession,
  claimAutomationRunPlan,
  createAutomationDefinition,
  createObservedAutomationRun,
  findAutomationDefinition,
  findAutomationDefinitionById,
  listAutomationDefinitions,
  listAutomationExecutionAuthorizationsForRun,
  listAutomationRuns,
  listAutomationRunSteps,
  listSchedulableAutomationDefinitions,
  markAutomationActionStep,
  markAutomationRunForSession,
  updateAutomationDefinition,
  upsertAutomationActionAuthorizations,
} from '../automation/automationDefinitionRepository';
import { createAutomationStageSession } from '../agents/agentSessionRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const resource = {
  appId: 'inbox',
  effectiveAccountId: 'aut-owner-1',
  resourceType: 'mailbox',
  resourceId: 'aut-mailbox-1',
};

describe('normalized automation definitions', () => {
  it('persists exact actions and materializes fresh run and step correlation', async () => {
    const automationId = uuidv7();
    const actionId = uuidv7();
    const runId = uuidv7();
    const authorizationId = `oxy-auth-${uuidv7()}`;
    const automation = await createAutomationDefinition(db, {
      id: automationId,
      ownerAccountId: 'aut-owner-1',
      objective: 'Reply to a message',
      triggerKind: 'event',
      eventAppId: 'inbox',
      eventType: 'email_needs_response',
      actorMode: 'fixed',
      fixedAgentId: 'aut-agent-1',
      eligibleAgentIds: [],
      executionMode: 'execute',
      actions: [{
        id: actionId,
        resource,
        tool: 'replyToEmail',
        input: { polite: true },
        limits: [{ key: 'daily', value: 10 }],
      }],
      inputs: {},
      resources: [resource],
      dataFlow: { sources: [resource], destinations: [resource] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: true,
    });
    await upsertAutomationActionAuthorizations(db, [{
      automationActionId: actionId,
      agentId: 'aut-agent-1',
      actorAccountId: 'aut-bot-1',
      oxyAuthorizationId: authorizationId,
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    expect(automation.executionMode).toBe('execute');
    expect(automation.actions).toEqual([expect.objectContaining({
      id: actionId,
      resource,
      tool: 'replyToEmail',
      limits: [{ key: 'daily', value: 10 }],
    })]);
    expect(await automationHasActiveAuthorizationCoverage(
      db,
      automationId,
      'aut-agent-1',
      [actionId],
    )).toBe(true);

    await expect(claimAutomationRunPlan({
      db,
      runId,
      automationId,
      requesterAccountId: 'aut-owner-1',
      triggerEventId: `event-${uuidv7()}`,
      stages: [{
        stage: 0,
        selectedAgentId: 'aut-agent-1',
        selectedActorAccountId: 'aut-bot-1',
        resource,
        taskInput: { objective: automation.objective },
        actions: automation.actions,
      }],
    })).resolves.toBe(true);

    const references = await listAutomationExecutionAuthorizationsForRun(db, runId, 'aut-agent-1', 0);
    expect(references).toEqual([expect.objectContaining({
      automationActionId: actionId,
      oxyAuthorizationId: authorizationId,
      tool: 'replyToEmail',
    })]);
    const stepId = references[0]?.stepId;
    if (!stepId) throw new Error('Expected an action step');
    await markAutomationActionStep(db, stepId, 'succeeded', 'audit-event-1');
    expect((await listAutomationRunSteps(db, runId)).find((step) => step.id === stepId))
      .toEqual(expect.objectContaining({ status: 'succeeded', auditEventId: 'audit-event-1' }));
  });

  it('updates editable fields and assignment order without replacing exact actions', async () => {
    const automationId = uuidv7();
    const actionId = uuidv7();
    const initial = await createAutomationDefinition(db, {
      id: automationId,
      ownerAccountId: 'aut-owner-edit',
      objective: 'Initial objective',
      triggerKind: 'manual',
      actorMode: 'fixed',
      fixedAgentId: 'editor-agent-1',
      eligibleAgentIds: [],
      executionMode: 'observe',
      actions: [{
        id: actionId,
        resource: { ...resource, effectiveAccountId: 'aut-owner-edit' },
        tool: 'searchEmails',
        input: {},
        limits: [],
      }],
      inputs: {},
      resources: [{ ...resource, effectiveAccountId: 'aut-owner-edit' }],
      dataFlow: { sources: [], destinations: [] },
      maximumAutonomy: 'execute_on_request',
      limits: [],
      enabled: false,
    });
    const destination = {
      appId: 'mention',
      effectiveAccountId: 'aut-owner-edit',
      resourceType: 'social_account',
      resourceId: 'profile-edit',
    };

    const updated = await updateAutomationDefinition(db, {
      id: automationId,
      ownerAccountId: 'aut-owner-edit',
      expectedUpdatedAt: initial.updatedAt,
      objective: 'Weekly published digest',
      triggerKind: 'schedule',
      scheduleCron: '0 9 * * 1',
      scheduleTimezone: 'UTC',
      actorMode: 'automatic',
      eligibleAgentIds: ['editor-agent-2', 'editor-agent-1'],
      resources: [...initial.resources, destination],
      dataFlow: { sources: initial.resources, destinations: [destination] },
      maximumAutonomy: 'autonomous',
      limits: [{ key: 'weekly', value: 1 }],
      enabled: true,
      authorizations: [],
    });

    expect(updated).toEqual(expect.objectContaining({
      objective: 'Weekly published digest',
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
      actorSelection: {
        mode: 'automatic',
        eligibleAgentIds: ['editor-agent-2', 'editor-agent-1'],
      },
      maximumAutonomy: 'autonomous',
      limits: [{ key: 'weekly', value: 1 }],
      enabled: true,
      actions: [expect.objectContaining({ id: actionId, tool: 'searchEmails' })],
    }));
    await expect(updateAutomationDefinition(db, {
      id: automationId,
      ownerAccountId: 'aut-owner-edit',
      expectedUpdatedAt: new Date(0),
      objective: 'Stale overwrite',
      triggerKind: 'manual',
      actorMode: 'fixed',
      fixedAgentId: 'editor-agent-1',
      eligibleAgentIds: [],
      resources: initial.resources,
      dataFlow: initial.dataFlow,
      maximumAutonomy: 'execute_on_request',
      limits: [],
      enabled: false,
      authorizations: [],
    })).resolves.toBeNull();
  });

  it('records observation mode without creating executable authority', async () => {
    const automationId = uuidv7();
    const actionId = uuidv7();
    const automation = await createAutomationDefinition(db, {
      id: automationId,
      ownerAccountId: 'aut-owner-observe',
      objective: 'Observe a weekly summary',
      triggerKind: 'event',
      eventAppId: 'noted',
      eventType: 'reminder.due',
      actorMode: 'fixed',
      fixedAgentId: 'aut-agent-observe',
      eligibleAgentIds: [],
      executionMode: 'observe',
      actions: [{
        id: actionId,
        resource: { ...resource, appId: 'noted', effectiveAccountId: 'aut-owner-observe' },
        tool: 'searchNotes',
        input: {},
        limits: [],
      }],
      inputs: {},
      resources: [{ ...resource, appId: 'noted', effectiveAccountId: 'aut-owner-observe' }],
      dataFlow: { sources: [], destinations: [] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: true,
    });
    const observedAction = automation.actions[0];
    if (!observedAction) throw new Error('Expected one observed action');
    const eventId = `event-${uuidv7()}`;
    await expect(createObservedAutomationRun({
      db,
      automationId,
      requesterAccountId: 'aut-owner-observe',
      triggerEventId: eventId,
      stages: [{
        stage: 0,
        selectedAgentId: 'aut-agent-observe',
        selectedActorAccountId: 'aut-bot-observe',
        resource: observedAction.resource,
        taskInput: { objective: automation.objective },
        actions: automation.actions,
      }],
    })).resolves.toBe(true);

    expect(await createObservedAutomationRun({
      db,
      automationId,
      requesterAccountId: 'aut-owner-observe',
      triggerEventId: eventId,
      stages: [{
        stage: 0,
        selectedAgentId: 'aut-agent-observe',
        selectedActorAccountId: 'aut-bot-observe',
        resource: observedAction.resource,
        taskInput: { objective: automation.objective },
        actions: automation.actions,
      }],
    })).toBe(false);
    const runs = await listAutomationRuns(db, 'aut-owner-observe', automationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('observed');
    const observedRun = runs[0];
    if (!observedRun) throw new Error('Expected one observed run');
    expect((await listAutomationRunSteps(db, observedRun.id)).map((step) => step.status))
      .toEqual(['observed', 'observed']);
    expect(await findAutomationDefinition(db, automationId, 'aut-owner-observe'))
      .toEqual(expect.objectContaining({ executionMode: 'observe' }));
  });

  it('advances two agent stages once each and finishes only after every action succeeds', async () => {
    const automationId = uuidv7();
    const readActionId = uuidv7();
    const publishActionId = uuidv7();
    const runId = uuidv7();
    const mentionResource = {
      appId: 'mention',
      effectiveAccountId: 'aut-owner-multi',
      resourceType: 'social_account',
      resourceId: 'profile-1',
    };
    const automation = await createAutomationDefinition(db, {
      id: automationId,
      ownerAccountId: 'aut-owner-multi',
      objective: 'Read notes and publish their summary',
      triggerKind: 'schedule',
      scheduleCron: '0 9 * * 1',
      scheduleTimezone: 'UTC',
      actorMode: 'automatic',
      eligibleAgentIds: ['reader-agent', 'publisher-agent'],
      executionMode: 'execute',
      actions: [
        { id: readActionId, resource, tool: 'searchEmails', input: {}, limits: [] },
        { id: publishActionId, resource: mentionResource, tool: 'publishPost', input: {}, limits: [] },
      ],
      inputs: {},
      resources: [resource, mentionResource],
      dataFlow: { sources: [resource], destinations: [mentionResource] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: true,
    });
    const [readAction, publishAction] = automation.actions;
    if (!readAction || !publishAction) throw new Error('Expected two automation actions');
    await upsertAutomationActionAuthorizations(db, [
      {
        automationActionId: readActionId,
        agentId: 'reader-agent',
        actorAccountId: 'reader-bot',
        oxyAuthorizationId: `oxy-auth-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        automationActionId: publishActionId,
        agentId: 'publisher-agent',
        actorAccountId: 'publisher-bot',
        oxyAuthorizationId: `oxy-auth-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    await expect(claimAutomationRunPlan({
      db,
      runId,
      automationId,
      requesterAccountId: 'aut-owner-multi',
      triggerEventId: `schedule:${automationId}:2026-09-07T09:00:00.000Z`,
      stages: [
        {
          stage: 0,
          selectedAgentId: 'reader-agent',
          selectedActorAccountId: 'reader-bot',
          resource,
          taskInput: { objective: automation.objective },
          actions: [readAction],
        },
        {
          stage: 1,
          selectedAgentId: 'publisher-agent',
          selectedActorAccountId: 'publisher-bot',
          resource: mentionResource,
          taskInput: { objective: automation.objective, receivePreviousResult: true },
          actions: [publishAction],
        },
      ],
    })).resolves.toBe(true);

    const reader = await createAutomationStageSession(db, {
      agentId: 'reader-agent',
      oxyUserId: 'aut-owner-multi',
      automationRunId: runId,
      automationStage: 0,
      task: 'read',
    });
    const [readAuthorization] = await listAutomationExecutionAuthorizationsForRun(
      db,
      runId,
      'reader-agent',
      0,
    );
    if (!readAuthorization) throw new Error('Expected reader authorization');
    await markAutomationActionStep(db, readAuthorization.stepId, 'succeeded');
    await markAutomationRunForSession(db, reader.session.id, 'succeeded');
    await expect(automationRunProgressForSession(db, reader.session.id)).resolves.toEqual(
      expect.objectContaining({ kind: 'next', runId, stage: 1, agentId: 'publisher-agent' }),
    );

    const publisher = await createAutomationStageSession(db, {
      agentId: 'publisher-agent',
      oxyUserId: 'aut-owner-multi',
      automationRunId: runId,
      automationStage: 1,
      task: 'publish',
    });
    const duplicatePublisher = await createAutomationStageSession(db, {
      agentId: 'publisher-agent',
      oxyUserId: 'aut-owner-multi',
      automationRunId: runId,
      automationStage: 1,
      task: 'publish again',
    });
    expect(publisher.created).toBe(true);
    expect(duplicatePublisher).toEqual(expect.objectContaining({
      created: false,
      session: expect.objectContaining({ id: publisher.session.id }),
    }));
    const [publishAuthorization] = await listAutomationExecutionAuthorizationsForRun(
      db,
      runId,
      'publisher-agent',
      1,
    );
    if (!publishAuthorization) throw new Error('Expected publisher authorization');
    await markAutomationActionStep(db, publishAuthorization.stepId, 'succeeded');
    await markAutomationRunForSession(db, publisher.session.id, 'succeeded');
    await expect(automationRunProgressForSession(db, publisher.session.id)).resolves.toEqual({
      kind: 'terminal',
      runId,
      status: 'succeeded',
    });
  });

  it('schedules normalized definitions', async () => {
    const automationId = uuidv7();
    await createAutomationDefinition(db, {
      id: automationId,
      ownerAccountId: 'aut-owner-schedule',
      objective: 'Prepare the weekly summary',
      triggerKind: 'schedule',
      scheduleCron: '0 9 * * 1',
      scheduleTimezone: 'UTC',
      actorMode: 'fixed',
      fixedAgentId: 'aut-agent-schedule',
      eligibleAgentIds: [],
      executionMode: 'observe',
      actions: [{
        id: uuidv7(),
        resource: { ...resource, appId: 'noted', effectiveAccountId: 'aut-owner-schedule' },
        tool: 'searchNotes',
        input: {},
        limits: [],
      }],
      inputs: {},
      resources: [{ ...resource, appId: 'noted', effectiveAccountId: 'aut-owner-schedule' }],
      dataFlow: { sources: [], destinations: [] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: true,
    });
    const scheduled = await listSchedulableAutomationDefinitions(db);
    expect(scheduled.filter((entry) => entry.ownerAccountId === 'aut-owner-schedule'))
      .toEqual([expect.objectContaining({ id: automationId })]);
    expect(await findAutomationDefinitionById(db, automationId))
      .toEqual(expect.objectContaining({
        trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
      }));
    expect(await listAutomationDefinitions(db, 'aut-owner-schedule'))
      .toContainEqual(expect.objectContaining({ id: automationId }));
  });
});
