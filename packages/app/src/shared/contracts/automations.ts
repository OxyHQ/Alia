export type AutomationAutonomy = 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
export type AutomationExecutionMode = 'observe' | 'execute';

export interface AutomationResource {
  appId: string;
  effectiveAccountId: string;
  resourceType: string;
  resourceId: string;
}

export interface AutomationAction {
  id: string;
  position: number;
  resource: AutomationResource;
  tool: string;
  input: Record<string, unknown>;
  limits: Array<{ key: string; value: number | boolean }>;
}

export type AutomationTrigger =
  | { type: 'manual' }
  | { type: 'event'; appId: string | null; eventType: string | null; resource?: AutomationResource | null }
  | { type: 'schedule'; cron: string | null; timezone: string | null };

export type AutomationActorSelection =
  | { mode: 'fixed'; agentId: string | null }
  | { mode: 'automatic'; eligibleAgentIds: string[] };

export interface AutomationDefinition {
  id: string;
  objective: string;
  trigger: AutomationTrigger;
  actorSelection: AutomationActorSelection;
  executionMode: AutomationExecutionMode;
  actions: AutomationAction[];
  inputs?: Record<string, unknown>;
  resources: AutomationResource[];
  dataFlow: { sources: AutomationResource[]; destinations: AutomationResource[] };
  maximumAutonomy: AutomationAutonomy;
  limits: Array<{ key: string; value: string | number | boolean | string[] }>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AutomationUpdateTrigger =
  | { type: 'manual' }
  | { type: 'event'; appId: string; eventType: string; resource?: AutomationResource }
  | { type: 'schedule'; cron: string; timezone: string };

export type AutomationUpdateActorSelection =
  | { mode: 'fixed'; agentId: string }
  | { mode: 'automatic'; eligibleAgentIds: string[] };

export interface AutomationUpdateInput {
  objective: string;
  instructions?: string;
  trigger: AutomationUpdateTrigger;
  actorSelection: AutomationUpdateActorSelection;
  resources: AutomationResource[];
  dataFlow: { sources: AutomationResource[]; destinations: AutomationResource[] };
  maximumAutonomy: AutomationAutonomy;
  limits: Array<{ key: string; value: string | number | boolean | string[] }>;
  enabled: boolean;
}

export interface AutomationCreateInput {
  objective: string;
  trigger: AutomationUpdateTrigger;
  actorSelection: AutomationUpdateActorSelection;
  executionMode: AutomationExecutionMode;
  actions: Array<{
    resource: AutomationResource;
    tool: string;
    input: Record<string, unknown>;
    limits: Array<{ key: string; value: number | boolean }>;
  }>;
  inputs: Record<string, unknown>;
  resources: AutomationResource[];
  dataFlow: { sources: AutomationResource[]; destinations: AutomationResource[] };
  maximumAutonomy: AutomationAutonomy;
  limits: Array<{ key: string; value: string | number | boolean | string[] }>;
  enabled: boolean;
}

export interface AutomationReceipt {
  objective: string;
  trigger: AutomationTrigger;
  actors: AutomationActorSelection;
  executionMode: AutomationExecutionMode;
  actions: AutomationAction[];
  resources: AutomationResource[];
  dataFlow: AutomationDefinition['dataFlow'];
  maximumAutonomy: AutomationAutonomy;
  limits: AutomationDefinition['limits'];
  enabled: boolean;
  undo: { method: 'DELETE'; path: string };
}

export type AutomationRunStatus =
  | 'planned'
  | 'running'
  | 'observed'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type AutomationStepStatus = AutomationRunStatus | 'denied';

export interface AutomationRun {
  id: string;
  automationId: string;
  selectedAgentId: string | null;
  status: AutomationRunStatus;
  policyDecision: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AutomationStep {
  id: string;
  runId: string;
  position: number;
  stage: number | null;
  actorType: 'alia' | 'agent';
  agentId: string | null;
  actorAccountId: string;
  resource: AutomationResource;
  tool: string;
  status: AutomationStepStatus;
  policyDecision: Record<string, unknown> | null;
  auditEventId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AutomationOverview {
  automations: AutomationDefinition[];
  runs: AutomationRun[];
}

// ── Labels the chat also draws ──────────────────────────────────────────────
//
// An automation's trigger is shown by the automations screens AND by the chat's
// tool card when an agent creates one, so the words live beside the type
// rather than in either feature: the chat may read a contract, never a
// feature that itself reads the chat.

/** The app's translator, as a parameter: these run outside React. */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

function cronDayList(field: string): number[] | null {
  const days: number[] = [];
  for (const part of field.split(',')) {
    const range = part.match(/^(\d)(?:-(\d))?$/);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from > 6 || to > 6 || to < from) return null;
    for (let day = from; day <= to; day += 1) days.push(day);
  }
  // Cron accepts 7 for Sunday in some dialects; the scheduler here writes 0.
  const unique = [...new Set(days)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : null;
}

/**
 * A cron expression as a sentence, for the shapes the app itself writes.
 *
 * `scheduleToCron` on the API produces exactly three forms from the create
 * dialog — `*\/N * * * *` for an interval, `M H * * *` for every day and
 * `M H * * 1,3,5` for chosen days — and those are what a person expects to
 * read back as "Every hour" or "Mondays at 09:00", not as five fields (#537).
 * Anything else (a hand-written structured schedule) is returned verbatim
 * rather than guessed at: a wrong sentence is worse than a cron string.
 */
export function cronLabel(cron: string, t: Translate): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (dayOfMonth !== '*' || month !== '*') return cron;

  const interval = minute.match(/^\*\/(\d+)$/);
  if (interval && hour === '*' && dayOfWeek === '*') {
    const minutes = Number(interval[1]);
    if (minutes === 60) return t('automations.cron.everyHour');
    if (minutes > 60 && minutes % 60 === 0) return t('automations.cron.everyHours', { count: minutes / 60 });
    return t('automations.cron.everyMinutes', { count: minutes });
  }

  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return cron;
  if (Number(minute) > 59 || Number(hour) > 23) return cron;
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (dayOfWeek === '*') return t('automations.cron.dailyAt', { time });
  const days = cronDayList(dayOfWeek);
  if (!days) return cron;
  if (days.length === 7) return t('automations.cron.dailyAt', { time });
  if (days.length === 5 && days.every((day, index) => day === index + 1)) {
    return t('automations.cron.weekdaysAt', { time });
  }
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return t('automations.cron.weekendsAt', { time });
  const names = days.map((day) => t(`automations.cron.dayPlural.${day}`));
  return t('automations.cron.daysAt', { days: names.join(', '), time });
}

export function triggerLabel(trigger: AutomationTrigger, t: Translate): string {
  if (trigger.type === 'manual') return t('automations.trigger.manual');
  if (trigger.type === 'event') {
    return `${trigger.appId ?? t('automations.trigger.anyApp')} · ${trigger.eventType ?? t('automations.trigger.anyEvent')}`;
  }
  return `${trigger.cron ? cronLabel(trigger.cron, t) : t('automations.trigger.unscheduled')} · ${trigger.timezone ?? 'UTC'}`;
}
