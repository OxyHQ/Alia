import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerRecord } from '../../db/automation/triggerRepository.js';

const { database, scheduleToCron, upsertLegacyTriggerAutomation } = vi.hoisted(() => ({
  database: { kind: 'test-db' },
  scheduleToCron: vi.fn(),
  upsertLegacyTriggerAutomation: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  upsertLegacyTriggerAutomation,
}));
vi.mock('../trigger-engine.js', () => ({ scheduleToCron }));

import { automationReceipt, syncStructuredAutomation } from '../structured-automation.js';

function trigger(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  const now = new Date('2026-09-02T00:00:00.000Z');
  return {
    _id: 'trigger-1',
    oxyUserId: 'owner-1',
    name: 'Weekly notes',
    type: 'schedule',
    enabled: true,
    action: {
      prompt: 'Summarize my notes',
      agentId: 'agent-1',
      useTools: true,
      notify: true,
      channelId: 'push',
    },
    schedule: { type: 'cron', cron: '0 9 * * 1', timezone: 'Europe/Bucharest' },
    triggerCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('structured automation synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduleToCron.mockReturnValue('0 9 * * 1');
    upsertLegacyTriggerAutomation.mockResolvedValue({ id: 'automation-1' });
  });

  it('persists the full scheduled-trigger control-plane projection', async () => {
    const source = trigger();
    await syncStructuredAutomation(source);

    expect(upsertLegacyTriggerAutomation).toHaveBeenCalledWith({
      db: database,
      legacyTriggerId: 'trigger-1',
      ownerAccountId: 'owner-1',
      objective: 'Summarize my notes',
      triggerKind: 'schedule',
      scheduleCron: '0 9 * * 1',
      scheduleTimezone: 'Europe/Bucharest',
      fixedAgentId: 'agent-1',
      inputs: { useTools: true, notify: true, channelId: 'push' },
      enabled: true,
    });
  });

  it('projects integration and webhook triggers without inventing a schedule', async () => {
    await syncStructuredAutomation(trigger({
      type: 'integration_event',
      schedule: undefined,
      integrationEvent: { service: 'noted', event: 'reminder.due' },
    }));
    expect(upsertLegacyTriggerAutomation).toHaveBeenLastCalledWith(expect.objectContaining({
      triggerKind: 'event',
      eventAppId: 'noted',
      eventType: 'reminder.due',
    }));

    await syncStructuredAutomation(trigger({ type: 'webhook', schedule: undefined }));
    expect(upsertLegacyTriggerAutomation).toHaveBeenLastCalledWith(expect.objectContaining({
      triggerKind: 'event',
      eventAppId: 'external_webhook',
      eventType: 'webhook',
    }));
  });

  it('builds one editable receipt shape for every creation surface', () => {
    const automation: Parameters<typeof automationReceipt>[0] = {
      id: 'automation-1',
      ownerAccountId: 'owner-1',
      objective: 'Summarize my notes',
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
      actorSelection: { mode: 'automatic', eligibleAgentIds: [] },
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
      actors: { mode: 'automatic', eligibleAgentIds: [] },
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
