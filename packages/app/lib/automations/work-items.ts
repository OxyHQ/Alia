import type { TaskSession } from '../hooks/use-tasks';
import { latestRunsByAutomation } from './format';
import type { AutomationDefinition, AutomationRun } from './types';

/**
 * The ONE list the Tasks page shows: agent sessions and automations together.
 *
 * ## The decision (#537)
 *
 * QA found two pages describing the same work from two angles — Tasks listed
 * the sessions agents ran, Automations listed the things that start them — and
 * neither told the whole story. The product decision is that Tasks is the
 * single place to see and manage work, and Automations is the welcome screen
 * that creates one. So this module merges both sources into one ordered list
 * of rows with a discriminated `kind`, and the page renders each kind with the
 * card it already had.
 *
 * ## Tabs keep their meaning
 *
 * - **Active** is what is happening or will happen: running and queued
 *   sessions, plus every ENABLED automation — an enabled automation is
 *   standing work even between runs.
 * - **History** is what is over: completed, failed and cancelled sessions,
 *   plus STOPPED automations.
 *
 * An automation's individual runs are NOT rows here. A run belongs to its
 * automation — the row shows the latest run's status and links to the full
 * history — so listing runs beside their parent would show one piece of work
 * twice with nothing tying the two together. A session that executes a stage
 * of a run (`automationRunId`) is folded under that automation for the same
 * reason, when the listing carries the id and the automation is in the tab.
 *
 * ## Order
 *
 * Running first, then queued and scheduled, then everything else; within a
 * band, most recent activity first. The type filter narrows this list and
 * never replaces it — "All" is the default and the unified view.
 */

export type WorkTab = 'active' | 'history';
export type WorkTypeFilter = 'all' | 'tasks' | 'automations';

export type WorkLifecycle =
  | 'running'
  | 'queued'
  | 'scheduled'
  | 'on_request'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkItem =
  | {
    kind: 'task';
    id: string;
    lifecycle: WorkLifecycle;
    /** Epoch milliseconds of the most recent activity, for ordering. */
    activityAt: number;
    task: TaskSession;
  }
  | {
    kind: 'automation';
    id: string;
    lifecycle: WorkLifecycle;
    activityAt: number;
    automation: AutomationDefinition;
    latestRun?: AutomationRun;
    /** The session currently executing this automation, when the listing links them. */
    session?: TaskSession;
  };

const ACTIVE_TASK_STATUSES: ReadonlySet<TaskSession['status']> = new Set(['running', 'queued']);

const LIFECYCLE_RANK: Record<WorkLifecycle, number> = {
  running: 0,
  queued: 1,
  scheduled: 2,
  on_request: 3,
  paused: 4,
  completed: 5,
  failed: 5,
  cancelled: 5,
};

function epoch(timestamp: string | undefined | null): number {
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function taskActivityAt(task: TaskSession): number {
  return Math.max(
    epoch(task.stats?.lastActivityAt),
    epoch(task.stats?.completedAt),
    epoch(task.stats?.startedAt),
    epoch(task.createdAt),
  );
}

/** What state an automation is in, from its definition and its latest run. */
export function automationLifecycle(
  automation: Pick<AutomationDefinition, 'enabled' | 'trigger'>,
  latestRun?: Pick<AutomationRun, 'status'>,
): WorkLifecycle {
  if (!automation.enabled) return 'paused';
  if (latestRun && (latestRun.status === 'running' || latestRun.status === 'planned')) {
    return 'running';
  }
  return automation.trigger.type === 'manual' ? 'on_request' : 'scheduled';
}

/** The pill text for a lifecycle, and the tone `AutomationPill` draws it in. */
export function lifecycleLabel(lifecycle: WorkLifecycle): {
  label: string;
  tone: 'neutral' | 'positive' | 'warning' | 'danger';
} {
  switch (lifecycle) {
    case 'running': return { label: 'Running', tone: 'warning' };
    case 'queued': return { label: 'Queued', tone: 'neutral' };
    case 'scheduled': return { label: 'Scheduled', tone: 'positive' };
    case 'on_request': return { label: 'On request', tone: 'positive' };
    case 'paused': return { label: 'Paused', tone: 'neutral' };
    case 'completed': return { label: 'Completed', tone: 'positive' };
    case 'failed': return { label: 'Failed', tone: 'danger' };
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral' };
  }
}

function inTab(lifecycle: WorkLifecycle, tab: WorkTab): boolean {
  const over = lifecycle === 'paused'
    || lifecycle === 'completed'
    || lifecycle === 'failed'
    || lifecycle === 'cancelled';
  return tab === 'history' ? over : !over;
}

export function compareWorkItems(a: WorkItem, b: WorkItem): number {
  const byRank = LIFECYCLE_RANK[a.lifecycle] - LIFECYCLE_RANK[b.lifecycle];
  if (byRank !== 0) return byRank;
  if (a.activityAt !== b.activityAt) return b.activityAt - a.activityAt;
  // A stable tie-break so equal rows never swap between renders.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function unifiedWorkItems(input: {
  tasks: readonly TaskSession[];
  automations: readonly AutomationDefinition[];
  runs: readonly AutomationRun[];
  tab: WorkTab;
  typeFilter?: WorkTypeFilter;
}): WorkItem[] {
  const typeFilter = input.typeFilter ?? 'all';
  const latestRuns = latestRunsByAutomation(input.runs);
  const automationOfRun = new Map(input.runs.map((run) => [run.id, run.automationId]));

  const automationItems = new Map<string, Extract<WorkItem, { kind: 'automation' }>>();
  if (typeFilter !== 'tasks') {
    for (const automation of input.automations) {
      const latestRun = latestRuns.get(automation.id);
      const lifecycle = automationLifecycle(automation, latestRun);
      if (!inTab(lifecycle, input.tab)) continue;
      automationItems.set(automation.id, {
        kind: 'automation',
        id: automation.id,
        lifecycle,
        activityAt: Math.max(
          epoch(latestRun?.startedAt),
          epoch(latestRun?.completedAt),
          epoch(automation.updatedAt),
          epoch(automation.createdAt),
        ),
        automation,
        latestRun,
      });
    }
  }

  const items: WorkItem[] = [];
  const seenTasks = new Set<string>();
  if (typeFilter !== 'automations') {
    for (const task of input.tasks) {
      if (seenTasks.has(task._id)) continue;
      seenTasks.add(task._id);

      const parentId = task.automationRunId ? automationOfRun.get(task.automationRunId) : undefined;
      const parent = parentId ? automationItems.get(parentId) : undefined;
      if (parent) {
        // The session is this automation's work in progress: fold it in,
        // keeping the most recent one, and let a live session mark the
        // automation as running even before its run row says so.
        if (!parent.session || taskActivityAt(task) > taskActivityAt(parent.session)) {
          parent.session = task;
        }
        if (ACTIVE_TASK_STATUSES.has(task.status)) parent.lifecycle = 'running';
        parent.activityAt = Math.max(parent.activityAt, taskActivityAt(task));
        continue;
      }

      const lifecycle: WorkLifecycle = task.status;
      if (!inTab(lifecycle, input.tab)) continue;
      items.push({
        kind: 'task',
        id: task._id,
        lifecycle,
        activityAt: taskActivityAt(task),
        task,
      });
    }
  }

  items.push(...automationItems.values());
  return items.sort(compareWorkItems);
}
