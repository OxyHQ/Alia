import { uuidv7 } from '@oxyhq/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  automationHasActiveAuthorizationCoverage,
  createAutomationDefinition,
  createAutomationRunForSession,
  createObservedAutomationRun,
  findAutomationDefinition,
  listAutomationExecutionAuthorizationsForRun,
  listAutomationRuns,
  listAutomationRunSteps,
  markAutomationActionStep,
  upsertAutomationActionAuthorizations,
} from '../automation/automationDefinitionRepository';
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
    const sessionId = uuidv7();
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

    await expect(createAutomationRunForSession({
      db,
      sessionId,
      automationId,
      requesterAccountId: 'aut-owner-1',
      selectedAgentId: 'aut-agent-1',
      selectedActorAccountId: 'aut-bot-1',
      triggerEventId: `event-${uuidv7()}`,
      resource,
      objective: automation.objective,
      actions: automation.actions,
    })).resolves.toBe(true);

    const references = await listAutomationExecutionAuthorizationsForRun(db, sessionId, 'aut-agent-1');
    expect(references).toEqual([expect.objectContaining({
      automationActionId: actionId,
      oxyAuthorizationId: authorizationId,
      tool: 'replyToEmail',
    })]);
    const stepId = references[0]?.stepId;
    if (!stepId) throw new Error('Expected an action step');
    await markAutomationActionStep(db, stepId, 'succeeded');
    expect((await listAutomationRunSteps(db, sessionId)).find((step) => step.id === stepId)?.status)
      .toBe('succeeded');
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
      selectedAgentId: 'aut-agent-observe',
      selectedActorAccountId: 'aut-bot-observe',
      triggerEventId: eventId,
      resource: observedAction.resource,
      objective: automation.objective,
      actions: automation.actions,
    })).resolves.toBe(true);

    expect(await createObservedAutomationRun({
      db,
      automationId,
      requesterAccountId: 'aut-owner-observe',
      selectedAgentId: 'aut-agent-observe',
      selectedActorAccountId: 'aut-bot-observe',
      triggerEventId: eventId,
      resource: observedAction.resource,
      objective: automation.objective,
      actions: automation.actions,
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
});
