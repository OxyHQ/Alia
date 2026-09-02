import { describe, expect, it } from 'vitest';
import { automationControlRequests } from '../control';

describe('automationControlRequests', () => {
  it('keeps legacy definitions on the trigger control plane', () => {
    expect(automationControlRequests({
      id: 'legacy-trigger-trigger-1',
      legacyTriggerId: 'trigger-1',
      trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' },
    })).toEqual({
      update: { method: 'PATCH', path: '/triggers/trigger-1' },
      stop: { method: 'PATCH', path: '/triggers/trigger-1' },
      run: { method: 'POST', path: '/triggers/trigger-1/run' },
    });
  });

  it('uses the structured control plane for native manual definitions', () => {
    expect(automationControlRequests({
      id: 'automation-1',
      legacyTriggerId: null,
      trigger: { type: 'manual' },
    })).toEqual({
      update: { method: 'PATCH', path: '/automations/automation-1' },
      stop: { method: 'DELETE', path: '/automations/automation-1' },
      run: { method: 'POST', path: '/automations/automation-1/run' },
    });
  });

  it('does not expose an on-request run for structured event or schedule definitions', () => {
    expect(automationControlRequests({
      id: 'automation-2',
      legacyTriggerId: null,
      trigger: { type: 'event', appId: 'inbox', eventType: 'email.received' },
    }).run).toBeNull();
  });
});
