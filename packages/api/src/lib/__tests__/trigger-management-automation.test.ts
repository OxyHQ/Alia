import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  automationReceipt,
  database,
  deleteTriggerForUser,
  disableLegacyTriggerAutomation,
  findTriggerForUser,
  reloadTrigger,
  syncStructuredAutomation,
  updateTrigger,
} = vi.hoisted(() => ({
  automationReceipt: vi.fn(),
  database: { kind: 'test-db' },
  deleteTriggerForUser: vi.fn(),
  disableLegacyTriggerAutomation: vi.fn(),
  findTriggerForUser: vi.fn(),
  reloadTrigger: vi.fn(),
  syncStructuredAutomation: vi.fn(),
  updateTrigger: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../db/automation/triggerRepository.js', () => ({
  deleteTriggerForUser,
  findTriggerForUser,
  listTriggers: vi.fn(),
  updateTrigger,
}));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  disableLegacyTriggerAutomation,
}));
vi.mock('../trigger-engine.js', () => ({
  reloadTrigger,
}));
vi.mock('../structured-automation.js', () => ({
  automationReceipt,
  syncStructuredAutomation,
}));
vi.mock('../logger.js', () => ({
  log: { triggers: { error: vi.fn() } },
}));

import {
  deleteTriggerTool,
  updateTriggerTool,
} from '../tools/trigger-management.js';

interface ExecutableTool {
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

describe('conversational legacy trigger maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncStructuredAutomation.mockResolvedValue({ id: 'automation-1' });
    automationReceipt.mockReturnValue({ undo: { method: 'DELETE', path: '/automations/automation-1' } });
    reloadTrigger.mockResolvedValue(undefined);
    disableLegacyTriggerAutomation.mockResolvedValue(undefined);
  });

  it('keeps the structured definition aligned after a conversational update', async () => {
    const existing = {
      _id: 'trigger-1',
      oxyUserId: 'owner-1',
      name: 'Weekly notes',
      type: 'schedule',
      enabled: true,
      action: { prompt: 'Summarize my notes', useTools: true, notify: true },
      schedule: { type: 'cron', cron: '0 9 * * 1', timezone: 'UTC' },
      triggerCount: 0,
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    };
    const updated = { ...existing, name: 'Monday notes' };
    findTriggerForUser.mockResolvedValue(existing);
    updateTrigger.mockResolvedValue(updated);

    const tool = updateTriggerTool('owner-1') as unknown as ExecutableTool;
    const result = await tool.execute({ triggerId: 'trigger-1', name: 'Monday notes' });

    expect(syncStructuredAutomation).toHaveBeenCalledWith(updated);
    expect(reloadTrigger).toHaveBeenCalledWith('trigger-1');
    expect(result).toMatchObject({
      success: true,
      name: 'Monday notes',
      automation: { id: 'automation-1' },
      receipt: { undo: { method: 'DELETE', path: '/automations/automation-1' } },
    });
  });

  it('stops the structured definition when its conversational trigger is deleted', async () => {
    deleteTriggerForUser.mockResolvedValue({ name: 'Weekly notes' });

    const tool = deleteTriggerTool('owner-1') as unknown as ExecutableTool;
    const result = await tool.execute({ triggerId: 'trigger-1' });

    expect(deleteTriggerForUser).toHaveBeenCalledWith(database, 'trigger-1', 'owner-1');
    expect(disableLegacyTriggerAutomation).toHaveBeenCalledWith(database, 'trigger-1');
    expect(reloadTrigger).toHaveBeenCalledWith('trigger-1');
    expect(result).toEqual({
      success: true,
      stopped: true,
      message: 'Trigger "Weekly notes" deleted',
    });
  });
});
