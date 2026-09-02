import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  canRunNow,
  latestRunsByAutomation,
  policyReason,
  resourceLabel,
  to24Hour,
  triggerLabel,
} from '../format';
import type { AutomationDefinition, AutomationRun } from '../types';

const baseAutomation = {
  id: 'automation-1',
  legacyTriggerId: null,
  trigger: { type: 'manual' as const },
} satisfies Pick<AutomationDefinition, 'id' | 'legacyTriggerId' | 'trigger'>;

function run(id: string, automationId: string, startedAt: string): AutomationRun {
  return {
    id,
    automationId,
    selectedAgentId: null,
    status: 'succeeded',
    policyDecision: null,
    startedAt,
    completedAt: startedAt,
  };
}

describe('automation formatting', () => {
  it('converts user-facing clock values to 24-hour time', () => {
    expect(to24Hour('12:00 AM')).toBe('00:00');
    expect(to24Hour('12:30 PM')).toBe('12:30');
    expect(to24Hour('6:05 pm')).toBe('18:05');
    expect(to24Hour('18:05')).toBe('18:05');
    expect(to24Hour('29:90')).toBeNull();
    expect(to24Hour('invalid')).toBeNull();
  });

  it('describes each trigger and actor-selection shape', () => {
    expect(triggerLabel({ type: 'manual' })).toBe('Manual request');
    expect(triggerLabel({ type: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Bucharest' }))
      .toBe('0 9 * * 1 · Europe/Bucharest');
    expect(actorLabel({ mode: 'fixed', agentId: 'agent-1' }, () => 'Writer'))
      .toBe('Writer');
    expect(actorLabel({ mode: 'automatic', eligibleAgentIds: [] }, () => 'unused'))
      .toBe('No eligible agents');
    expect(actorLabel({ mode: 'automatic', eligibleAgentIds: [] }, () => 'unused', true))
      .toBe('Alia (legacy routine)');
    expect(resourceLabel({
      appId: 'inbox',
      effectiveAccountId: 'company-1',
      resourceType: 'mailbox',
      resourceId: 'support',
    })).toBe('inbox · company-1 · mailbox/support');
  });

  it('selects the newest run per automation even if the response is unordered', () => {
    const runs = [
      run('old', 'automation-1', '2026-09-01T09:00:00Z'),
      run('other', 'automation-2', '2026-09-01T10:00:00Z'),
      run('new', 'automation-1', '2026-09-02T09:00:00Z'),
    ];
    const latest = latestRunsByAutomation(runs);
    expect(latest.get('automation-1')?.id).toBe('new');
    expect(latest.get('automation-2')?.id).toBe('other');
  });

  it('surfaces the policy reason and permits only valid manual controls', () => {
    expect(policyReason({
      ...run('run-1', 'automation-1', '2026-09-02T09:00:00Z'),
      policyDecision: { reason: 'grant_revoked' },
    }))
      .toBe('Grant Revoked');
    expect(canRunNow(baseAutomation)).toBe(true);
    expect(canRunNow({
      ...baseAutomation,
      trigger: { type: 'event', appId: 'inbox', eventType: 'email.received' },
    })).toBe(false);
    expect(canRunNow({ ...baseAutomation, legacyTriggerId: 'trigger-1' }))
      .toBe(true);
  });
});
