import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createStructuredAutomation } = vi.hoisted(() => ({
  createStructuredAutomation: vi.fn(),
}));

vi.mock('../../structured-automation-creation.js', async () => {
  const { z } = await import('zod');
  class AutomationCreationError extends Error {
    readonly context = {};
  }
  return {
    AutomationCreationError,
    createAutomationSchema: z.object({}).passthrough(),
    createStructuredAutomation,
  };
});

vi.mock('../../logger.js', () => ({
  log: { triggers: { error: vi.fn() } },
}));

import { createAutomationTool } from '../automation-create.js';

interface ExecutableTool {
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const resource = {
  appId: 'noted',
  effectiveAccountId: 'owner-1',
  resourceType: 'workspace',
  resourceId: 'notes-1',
};

const definition = {
  objective: 'Send a weekly notes summary',
  trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Madrid' },
  actorSelection: { mode: 'fixed', agentId: 'agent-1' },
  executionMode: 'execute',
  actions: [{ resource, tool: 'searchNotes', input: {}, limits: [] }],
  inputs: {},
  resources: [resource],
  dataFlow: { sources: [resource], destinations: [] },
  maximumAutonomy: 'autonomous',
  limits: [],
  enabled: true,
};

describe('structured automation creation tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createStructuredAutomation.mockResolvedValue({
      automation: {
        id: 'automation-1',
        objective: 'Send a weekly notes summary',
        enabled: true,
        trigger: definition.trigger,
      },
      receipt: { undo: { method: 'DELETE', path: '/automations/automation-1' } },
    });
  });

  it('uses the same creation service as HTTP and returns the editable receipt', async () => {
    const tool = createAutomationTool('owner-1', 'live-user-token') as unknown as ExecutableTool;
    const result = await tool.execute(definition);

    expect(createStructuredAutomation).toHaveBeenCalledWith({
      ownerAccountId: 'owner-1',
      accessToken: 'live-user-token',
      definition,
    });
    expect(result).toEqual({
      success: true,
      automation: {
        id: 'automation-1',
        objective: 'Send a weekly notes summary',
        enabled: true,
        trigger: definition.trigger,
      },
      receipt: { undo: { method: 'DELETE', path: '/automations/automation-1' } },
      card: {
        type: 'scheduled-task',
        data: {
          id: 'automation-1',
          objective: 'Send a weekly notes summary',
          enabled: true,
          trigger: definition.trigger,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('live-user-token');
  });

  it('accepts an assistant task with no fake app action', async () => {
    const assistantTask = {
      ...definition,
      actions: [],
      resources: [],
      dataFlow: { sources: [], destinations: [] },
      inputs: { instructions: 'Remind me to call Alex' },
    };
    const tool = createAutomationTool('owner-1', 'live-user-token') as unknown as ExecutableTool;

    await expect(tool.execute(assistantTask)).resolves.toEqual(expect.objectContaining({
      success: true,
    }));
    expect(createStructuredAutomation).toHaveBeenCalledWith(expect.objectContaining({
      definition: assistantTask,
    }));
  });
});
