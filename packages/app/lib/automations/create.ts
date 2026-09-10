import type {
  AutomationCreateInput,
  AutomationExecutionMode,
  AutomationResource,
} from './types';

export interface ScheduledAutomationDraft {
  objective: string;
  instructions: string;
  schedule:
    | { type: 'daily'; time: string; days: string[] }
    | { type: 'hourly' };
  timezone: string;
  agentId: string;
  executionMode: AutomationExecutionMode;
  resource: AutomationResource;
  tool: string;
}

export type ScheduledAutomationCreateResult =
  | { ok: true; value: AutomationCreateInput }
  | { ok: false; error: string };

const DAY_NUMBERS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function cleanResource(resource: AutomationResource): AutomationResource {
  return {
    appId: resource.appId.trim(),
    effectiveAccountId: resource.effectiveAccountId.trim(),
    resourceType: resource.resourceType.trim(),
    resourceId: resource.resourceId.trim(),
  };
}

function dailyCron(time: string, days: readonly string[]): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const dayNumbers = [...new Set(days.map((day) => DAY_NUMBERS[day]).filter(
    (day): day is number => day !== undefined,
  ))].sort((left, right) => left - right);
  if (dayNumbers.length !== new Set(days).size || dayNumbers.length === 0) return null;
  return `${minute} ${hour} * * ${dayNumbers.length === 7 ? '*' : dayNumbers.join(',')}`;
}

export function buildScheduledAutomationCreate(
  draft: ScheduledAutomationDraft,
): ScheduledAutomationCreateResult {
  const objective = draft.objective.trim();
  const instructions = draft.instructions.trim();
  const agentId = draft.agentId.trim();
  const timezone = draft.timezone.trim();
  const tool = draft.tool.trim();
  const resource = cleanResource(draft.resource);
  if (!objective || !instructions) {
    return { ok: false, error: 'Name and instructions are required' };
  }
  if (!agentId) return { ok: false, error: 'Choose the responsible agent' };
  if (!timezone) return { ok: false, error: 'Timezone is required' };
  if (!Object.values(resource).every(Boolean)) {
    return { ok: false, error: 'Every resource field is required' };
  }
  if (!tool) return { ok: false, error: 'An exact app tool is required' };
  const cron = draft.schedule.type === 'hourly'
    ? '0 * * * *'
    : dailyCron(draft.schedule.time, draft.schedule.days);
  if (!cron) return { ok: false, error: 'Choose a valid time and at least one valid day' };

  return {
    ok: true,
    value: {
      objective,
      trigger: { type: 'schedule', cron, timezone },
      actorSelection: { mode: 'fixed', agentId },
      executionMode: draft.executionMode,
      actions: [{ resource, tool, input: {}, limits: [] }],
      inputs: { instructions },
      resources: [resource],
      dataFlow: { sources: [resource], destinations: [resource] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: true,
    },
  };
}
