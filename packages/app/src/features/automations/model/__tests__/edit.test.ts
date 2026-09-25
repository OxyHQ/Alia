import { describe, expect, it } from 'vitest';
import { buildAutomationUpdate, createAutomationEditDraft } from '../edit';
import type { AutomationDefinition } from '@/shared/contracts/automations';
import type { AutomationEditResult } from '../edit';
import { translator } from '@/shared/testing/translate';

const t = translator('en');

/** What the editor's toast says for a result, in the shipped English. */
const message = (result: AutomationEditResult): string | null =>
  result.ok ? null : t(result.error, result.params);

const mailbox = {
  appId: 'inbox',
  effectiveAccountId: 'owner-1',
  resourceType: 'mailbox',
  resourceId: 'mailbox-1',
};

const automation: AutomationDefinition = {
  id: 'automation-1',
  objective: 'Reply to important email',
  trigger: {
    type: 'event',
    appId: 'inbox',
    eventType: 'email_needs_response',
    resource: mailbox,
  },
  actorSelection: { mode: 'fixed', agentId: 'agent-1' },
  executionMode: 'execute',
  actions: [{
    id: 'action-1',
    position: 0,
    resource: mailbox,
    tool: 'replyToEmail',
    input: {},
    limits: [],
  }],
  resources: [mailbox],
  dataFlow: { sources: [mailbox], destinations: [mailbox] },
  maximumAutonomy: 'autonomous',
  limits: [
    { key: 'daily', value: 5 },
    { key: 'recipients', value: ['customer@example.test'] },
  ],
  enabled: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

describe('automation receipt editor', () => {
  it('creates an isolated draft with every editable field', () => {
    const draft = createAutomationEditDraft(automation);

    expect(draft).toEqual(expect.objectContaining({
      objective: automation.objective,
      trigger: automation.trigger,
      actorSelection: automation.actorSelection,
      resources: automation.resources,
      dataFlow: automation.dataFlow,
      maximumAutonomy: 'autonomous',
      limits: [
        { key: 'daily', value: '5' },
        { key: 'recipients', value: '["customer@example.test"]' },
      ],
      enabled: true,
    }));
    const draftResource = draft.resources[0];
    if (!draftResource) throw new Error('Expected one editable resource');
    draftResource.resourceId = 'changed';
    expect(automation.resources[0]?.resourceId).toBe('mailbox-1');
  });

  it('builds a typed update and parses limit values without changing exact actions', () => {
    const draft = createAutomationEditDraft(automation);
    draft.objective = '  Send a weekly digest  ';
    draft.trigger = { type: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Madrid' };
    draft.actorSelection = { mode: 'automatic', eligibleAgentIds: ['agent-2', 'agent-1'] };
    draft.limits = [
      { key: 'weekly', value: '1' },
      { key: 'notify', value: 'true' },
      { key: 'channels', value: '["push","in_app"]' },
      { key: 'label', value: 'digest' },
    ];

    expect(buildAutomationUpdate(draft)).toEqual({
      ok: true,
      value: expect.objectContaining({
        objective: 'Send a weekly digest',
        trigger: draft.trigger,
        actorSelection: draft.actorSelection,
        limits: [
          { key: 'weekly', value: 1 },
          { key: 'notify', value: true },
          { key: 'channels', value: ['push', 'in_app'] },
          { key: 'label', value: 'digest' },
        ],
      }),
    });
  });

  it('rejects incomplete actor, trigger, resource, and limit inputs before PATCH', () => {
    const noActor = createAutomationEditDraft(automation);
    noActor.actorSelection = { mode: 'automatic', eligibleAgentIds: [] };
    expect(message(buildAutomationUpdate(noActor))).toBe('Choose at least one eligible agent');

    const badEvent = createAutomationEditDraft(automation);
    badEvent.trigger = { type: 'event', appId: '', eventType: 'changed' };
    expect(message(buildAutomationUpdate(badEvent))).toBe('Event app and type are required');

    const badResource = createAutomationEditDraft(automation);
    badResource.resources = [{ ...mailbox, resourceId: '' }];
    expect(message(buildAutomationUpdate(badResource))).toBe('Every resource field is required');

    const badLimit = createAutomationEditDraft(automation);
    badLimit.limits = [{ key: 'recipients', value: '[1,2]' }];
    expect(message(buildAutomationUpdate(badLimit))).toBe('Limit recipients must be text, a number, a boolean, or a text list');

    const duplicateLimit = createAutomationEditDraft(automation);
    duplicateLimit.limits = [
      { key: 'daily', value: '5' },
      { key: 'daily', value: '10' },
    ];
    expect(message(buildAutomationUpdate(duplicateLimit))).toBe('Limit daily is duplicated');
  });
});
