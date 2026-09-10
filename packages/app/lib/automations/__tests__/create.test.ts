import { describe, expect, it } from 'vitest';
import { buildScheduledAutomationCreate } from '../create';

const resource = {
  appId: 'noted',
  effectiveAccountId: 'owner-1',
  resourceType: 'workspace',
  resourceId: 'notes-1',
};

describe('structured automation creation', () => {
  it('builds the exact POST contract for a daily schedule', () => {
    expect(buildScheduledAutomationCreate({
      objective: ' Weekly notes ',
      instructions: ' Summarize this week ',
      schedule: { type: 'daily', time: '09:30', days: ['monday', 'wednesday', 'friday'] },
      timezone: 'Europe/Bucharest',
      agentId: 'agent-1',
      executionMode: 'observe',
      resource,
      tool: 'searchNotes',
    })).toEqual({
      ok: true,
      value: {
        objective: 'Weekly notes',
        trigger: { type: 'schedule', cron: '30 9 * * 1,3,5', timezone: 'Europe/Bucharest' },
        actorSelection: { mode: 'fixed', agentId: 'agent-1' },
        executionMode: 'observe',
        actions: [{ resource, tool: 'searchNotes', input: {}, limits: [] }],
        inputs: { instructions: 'Summarize this week' },
        resources: [resource],
        dataFlow: { sources: [resource], destinations: [resource] },
        maximumAutonomy: 'autonomous',
        limits: [],
        enabled: true,
      },
    });
  });

  it('uses one stable cron expression for hourly schedules', () => {
    const result = buildScheduledAutomationCreate({
      objective: 'Check notes',
      instructions: 'Find reminders',
      schedule: { type: 'hourly' },
      timezone: 'UTC',
      agentId: 'agent-1',
      executionMode: 'execute',
      resource,
      tool: 'searchNotes',
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'UTC' },
        executionMode: 'execute',
      }),
    }));
  });

  it('fails before POST when authority coordinates are incomplete', () => {
    expect(buildScheduledAutomationCreate({
      objective: 'Check notes',
      instructions: 'Find reminders',
      schedule: { type: 'daily', time: '09:00', days: ['monday'] },
      timezone: 'UTC',
      agentId: '',
      executionMode: 'observe',
      resource,
      tool: 'searchNotes',
    })).toEqual({ ok: false, error: 'Choose the responsible agent' });
  });
});
