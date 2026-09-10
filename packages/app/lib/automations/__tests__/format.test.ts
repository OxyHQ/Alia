import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  automationTitle,
  canRunNow,
  cronLabel,
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
      .toBe('Mondays at 09:00 · Europe/Bucharest');
    expect(triggerLabel({ type: 'schedule', cron: null, timezone: null }))
      .toBe('Unscheduled · UTC');
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
    expect(canRunNow({
      ...baseAutomation,
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
    })).toBe(true);
    expect(canRunNow({ ...baseAutomation, legacyTriggerId: 'trigger-1' }))
      .toBe(true);
  });
});

/**
 * The schedules the create dialog writes (`scheduleToCron` on the API) read
 * back as sentences; anything else stays a cron string rather than a guess.
 */
describe('cronLabel', () => {
  it('reads the three shapes the app writes', () => {
    expect(cronLabel('*/60 * * * *')).toBe('Every hour');
    expect(cronLabel('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronLabel('*/120 * * * *')).toBe('Every 2 hours');
    expect(cronLabel('0 18 * * *')).toBe('Daily at 18:00');
    expect(cronLabel('30 9 * * 1')).toBe('Mondays at 09:30');
    expect(cronLabel('0 9 * * 1,3,5')).toBe('Mondays, Wednesdays, Fridays at 09:00');
    expect(cronLabel('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(cronLabel('0 9 * * 0,6')).toBe('Weekends at 09:00');
    expect(cronLabel('0 9 * * 0,1,2,3,4,5,6')).toBe('Daily at 09:00');
  });

  it('leaves what it cannot read alone', () => {
    expect(cronLabel('0 9 1 * *')).toBe('0 9 1 * *');
    expect(cronLabel('0 9 * 6 *')).toBe('0 9 * 6 *');
    expect(cronLabel('*/5 9 * * *')).toBe('*/5 9 * * *');
    expect(cronLabel('0 25 * * *')).toBe('0 25 * * *');
    expect(cronLabel('0 9 * * 8')).toBe('0 9 * * 8');
    expect(cronLabel('not cron')).toBe('not cron');
  });
});

describe('automationTitle', () => {
  it('prefers the name and falls back to the objective', () => {
    expect(automationTitle({ name: 'PR watch', objective: 'Review PRs' })).toBe('PR watch');
    expect(automationTitle({ name: null, objective: 'Review PRs' })).toBe('Review PRs');
    expect(automationTitle({ name: '   ', objective: 'Review PRs' })).toBe('Review PRs');
  });
});
