import { describe, expect, it } from 'vitest';
import type { AutomationDefinitionRecord } from '../../db/automation/automationDefinitionRepository.js';
import { automationStageTaskInputs, renderAutomationStageTask } from '../automation-stage-task.js';

const source = {
  appId: 'noted',
  effectiveAccountId: 'owner-1',
  resourceType: 'workspace',
  resourceId: 'notes-1',
};
const destination = {
  appId: 'mention',
  effectiveAccountId: 'owner-1',
  resourceType: 'social_account',
  resourceId: 'profile-1',
};
const readAction = { id: 'read', position: 0, resource: source, tool: 'searchNotes', input: {}, limits: [] };
const publishAction = { id: 'publish', position: 1, resource: destination, tool: 'publishPost', input: {}, limits: [] };

function automation(destinations = [destination]): AutomationDefinitionRecord {
  return {
    id: 'automation-1',
    ownerAccountId: 'owner-1',
    objective: 'Prepare and publish a weekly summary',
    trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
    actorSelection: { mode: 'automatic', eligibleAgentIds: ['reader', 'publisher'] },
    executionMode: 'execute',
    actions: [readAction, publishAction],
    inputs: { language: 'es' },
    resources: [source, destination],
    dataFlow: { sources: [source], destinations },
    maximumAutonomy: 'autonomous',
    limits: [],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const stages = [
  { stage: 0, agentId: 'reader', actorAccountId: 'reader-bot', actions: [readAction] },
  { stage: 1, agentId: 'publisher', actorAccountId: 'publisher-bot', actions: [publishAction] },
];

describe('automation stage task data flow', () => {
  it('hands the prior result only to a declared destination stage', () => {
    const inputs = automationStageTaskInputs(automation(), {
      kind: 'schedule',
      id: 'occurrence-1',
      occurredAt: new Date('2026-09-07T09:00:00.000Z'),
    }, stages);
    const publisherInput = inputs[1];
    if (!publisherInput) throw new Error('Expected publisher stage input');
    expect(publisherInput.receivePreviousResult).toBe(true);
    expect(renderAutomationStageTask(publisherInput, 'private summary')).toContain('private summary');
  });

  it('withholds the prior result when the destination was not declared', () => {
    const inputs = automationStageTaskInputs(automation([]), {
      kind: 'schedule',
      id: 'occurrence-1',
      occurredAt: new Date('2026-09-07T09:00:00.000Z'),
    }, stages);
    const publisherInput = inputs[1];
    if (!publisherInput) throw new Error('Expected publisher stage input');
    expect(publisherInput.receivePreviousResult).toBe(false);
    expect(renderAutomationStageTask(publisherInput, 'private summary')).not.toContain('private summary');
  });

  it('keeps manual request identity in audit storage rather than the agent task', () => {
    const [input] = automationStageTaskInputs({
      ...automation(),
      trigger: { type: 'manual' },
    }, {
      kind: 'manual',
      id: 'manual:automation-1:request-0001',
      requesterAccountId: 'owner-1',
      occurredAt: new Date('2026-09-07T09:00:00.000Z'),
    }, stages);
    if (!input) throw new Error('Expected manual stage input');

    expect(input.trigger).toEqual({
      type: 'manual',
      occurredAt: '2026-09-07T09:00:00.000Z',
    });
    expect(JSON.stringify(input.trigger)).not.toContain('request-0001');
    expect(JSON.stringify(input.trigger)).not.toContain('owner-1');
  });
});
