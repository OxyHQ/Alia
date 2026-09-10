import { describe, expect, it } from 'vitest';
import { automationReceipt } from '../structured-automation.js';

describe('structured automation receipt', () => {
  it('returns the editable definition and one explicit stop operation', () => {
    const automation: Parameters<typeof automationReceipt>[0] = {
      id: 'automation-1',
      ownerAccountId: 'owner-1',
      objective: 'Summarize my notes',
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
      actorSelection: { mode: 'automatic', eligibleAgentIds: ['agent-1'] },
      executionMode: 'execute',
      actions: [],
      inputs: {},
      resources: [],
      dataFlow: { sources: [], destinations: [] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: true,
      legacyTriggerId: null,
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    };

    expect(automationReceipt(automation)).toEqual({
      objective: 'Summarize my notes',
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
      actors: { mode: 'automatic', eligibleAgentIds: ['agent-1'] },
      executionMode: 'execute',
      actions: [],
      resources: [],
      dataFlow: { sources: [], destinations: [] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: true,
      undo: { method: 'DELETE', path: '/automations/automation-1' },
    });
  });
});
