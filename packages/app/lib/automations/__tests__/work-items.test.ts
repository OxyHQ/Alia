import { describe, expect, it } from 'vitest';
import type { TaskSession } from '../../hooks/use-tasks';
import type { AutomationDefinition, AutomationRun } from '../types';
import { automationLifecycle, lifecycleLabel, unifiedWorkItems } from '../work-items';

/**
 * The unified Tasks list (#537): sessions and automations in ONE ordered list,
 * running first, tabs keeping their meaning, runs folded under their parent.
 */

function session(
  id: string,
  status: TaskSession['status'],
  lastActivityAt: string,
  extra: Partial<TaskSession> = {},
): TaskSession {
  return {
    _id: id,
    agentId: null,
    status,
    task: `task ${id}`,
    stats: { totalTokens: 0, totalSteps: 0, lastActivityAt },
    createdAt: lastActivityAt,
    ...extra,
  };
}

function automation(
  id: string,
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    id,
    name: null,
    objective: `objective ${id}`,
    trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' },
    actorSelection: { mode: 'automatic', eligibleAgentIds: [] },
    executionMode: 'execute',
    actions: [],
    resources: [],
    dataFlow: { sources: [], destinations: [] },
    maximumAutonomy: 'autonomous',
    limits: [],
    enabled: true,
    legacyTriggerId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(id: string, automationId: string, status: AutomationRun['status'], startedAt: string): AutomationRun {
  return { id, automationId, selectedAgentId: null, status, policyDecision: null, startedAt, completedAt: null };
}

describe('unifiedWorkItems', () => {
  it('lists running work first, then queued and scheduled, then by recency', () => {
    const items = unifiedWorkItems({
      tasks: [
        session('queued-old', 'queued', '2026-09-09T08:00:00.000Z'),
        session('running-old', 'running', '2026-09-09T07:00:00.000Z'),
        session('running-new', 'running', '2026-09-09T09:00:00.000Z'),
      ],
      automations: [
        automation('scheduled', { updatedAt: '2026-09-09T10:00:00.000Z' }),
        automation('busy', { updatedAt: '2026-09-09T06:00:00.000Z' }),
      ],
      runs: [run('r1', 'busy', 'running', '2026-09-09T08:30:00.000Z')],
      tab: 'active',
    });
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'task:running-new',
      'automation:busy',
      'task:running-old',
      'task:queued-old',
      'automation:scheduled',
    ]);
    expect(items[1]).toMatchObject({ kind: 'automation', lifecycle: 'running' });
    expect(items[4]).toMatchObject({ kind: 'automation', lifecycle: 'scheduled' });
  });

  it('keeps the tab semantics: active is live work plus enabled automations, history the rest', () => {
    const tasks = [
      session('a', 'running', '2026-09-09T09:00:00.000Z'),
      session('b', 'completed', '2026-09-09T08:00:00.000Z'),
      session('c', 'failed', '2026-09-09T07:00:00.000Z'),
      session('d', 'cancelled', '2026-09-09T06:00:00.000Z'),
    ];
    const automations = [automation('on'), automation('off', { enabled: false })];

    const active = unifiedWorkItems({ tasks, automations, runs: [], tab: 'active' });
    expect(active.map((item) => item.id)).toEqual(['a', 'on']);

    const history = unifiedWorkItems({ tasks, automations, runs: [], tab: 'history' });
    expect(history.map((item) => item.id)).toEqual(['off', 'b', 'c', 'd']);
    expect(history[0]).toMatchObject({ kind: 'automation', lifecycle: 'paused' });
    expect(history.slice(1).map((item) => item.lifecycle)).toEqual(['completed', 'failed', 'cancelled']);
  });

  it('narrows by type without changing the unified default', () => {
    const input = {
      tasks: [session('t', 'running', '2026-09-09T09:00:00.000Z')],
      automations: [automation('a')],
      runs: [],
      tab: 'active' as const,
    };
    expect(unifiedWorkItems(input).map((item) => item.kind)).toEqual(['task', 'automation']);
    expect(unifiedWorkItems({ ...input, typeFilter: 'all' })).toEqual(unifiedWorkItems(input));
    expect(unifiedWorkItems({ ...input, typeFilter: 'tasks' }).map((item) => item.id)).toEqual(['t']);
    expect(unifiedWorkItems({ ...input, typeFilter: 'automations' }).map((item) => item.id)).toEqual(['a']);
  });

  it('folds a session that executes an automation run under that automation', () => {
    const items = unifiedWorkItems({
      tasks: [
        session('stage', 'running', '2026-09-09T09:00:00.000Z', { automationRunId: 'r1' }),
        session('orphan', 'running', '2026-09-09T08:00:00.000Z', { automationRunId: 'unknown-run' }),
      ],
      automations: [automation('parent', { trigger: { type: 'manual' } })],
      runs: [run('r1', 'parent', 'planned', '2026-09-09T08:59:00.000Z')],
      tab: 'active',
    });
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'automation:parent',
      'task:orphan',
    ]);
    expect(items[0]).toMatchObject({
      kind: 'automation',
      lifecycle: 'running',
      session: { _id: 'stage' },
      latestRun: { id: 'r1' },
    });
  });

  it('does not list the same session twice when both sources return it', () => {
    const same = session('dup', 'running', '2026-09-09T09:00:00.000Z');
    const items = unifiedWorkItems({ tasks: [same, { ...same }], automations: [], runs: [], tab: 'active' });
    expect(items).toHaveLength(1);
  });
});

describe('automationLifecycle', () => {
  it('reads the definition and the latest run', () => {
    const scheduled = automation('s');
    expect(automationLifecycle(scheduled)).toBe('scheduled');
    expect(automationLifecycle(scheduled, { status: 'succeeded' })).toBe('scheduled');
    expect(automationLifecycle(scheduled, { status: 'running' })).toBe('running');
    expect(automationLifecycle(scheduled, { status: 'planned' })).toBe('running');
    expect(automationLifecycle(automation('m', { trigger: { type: 'manual' } }))).toBe('on_request');
    expect(automationLifecycle(automation('p', { enabled: false }), { status: 'running' })).toBe('paused');
  });

  it('labels every lifecycle', () => {
    expect(lifecycleLabel('running')).toEqual({ label: 'Running', tone: 'warning' });
    expect(lifecycleLabel('paused')).toEqual({ label: 'Paused', tone: 'neutral' });
    expect(lifecycleLabel('failed')).toEqual({ label: 'Failed', tone: 'danger' });
    expect(lifecycleLabel('scheduled').label).toBe('Scheduled');
  });
});
