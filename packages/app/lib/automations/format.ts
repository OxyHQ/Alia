import type {
  AutomationActorSelection,
  AutomationAutonomy,
  AutomationDefinition,
  AutomationResource,
  AutomationRun,
  AutomationTrigger,
} from './types';

export function to24Hour(time12: string): string | null {
  const time24 = time12.match(/^(\d{1,2}):(\d{2})$/);
  if (time24) {
    const hours = Number.parseInt(time24[1] ?? '', 10);
    const minutes = Number.parseInt(time24[2] ?? '', 10);
    if (hours <= 23 && minutes <= 59) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }
  }
  const match = time12.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hours = Number.parseInt(match[1] ?? '9', 10);
  const minutes = Number.parseInt(match[2] ?? '', 10);
  if (hours < 1 || hours > 12 || minutes > 59) return null;
  const period = match[3]?.toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

export function humanizeIdentifier(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

export function autonomyLabel(autonomy: AutomationAutonomy): string {
  return humanizeIdentifier(autonomy);
}

const CRON_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
export function cronLabel(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (dayOfMonth !== '*' || month !== '*') return cron;

  const interval = minute.match(/^\*\/(\d+)$/);
  if (interval && hour === '*' && dayOfWeek === '*') {
    const minutes = Number(interval[1]);
    if (minutes === 60) return 'Every hour';
    if (minutes > 60 && minutes % 60 === 0) return `Every ${minutes / 60} hours`;
    return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`;
  }

  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return cron;
  if (Number(minute) > 59 || Number(hour) > 23) return cron;
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (dayOfWeek === '*') return `Daily at ${time}`;
  const days = cronDayList(dayOfWeek);
  if (!days) return cron;
  if (days.length === 7) return `Daily at ${time}`;
  if (days.length === 5 && days.every((day, index) => day === index + 1)) {
    return `Weekdays at ${time}`;
  }
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return `Weekends at ${time}`;
  const names = days.map((day) => `${CRON_DAY_NAMES[day]}s`);
  return `${names.join(', ')} at ${time}`;
}

export function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.type === 'manual') return 'Manual request';
  if (trigger.type === 'event') {
    return `${trigger.appId ?? 'Any app'} · ${trigger.eventType ?? 'Any event'}`;
  }
  return `${trigger.cron ? cronLabel(trigger.cron) : 'Unscheduled'} · ${trigger.timezone ?? 'UTC'}`;
}

/**
 * What an automation is called wherever it has a heading: the name its owner
 * gave it, and only when there is none, the objective (#534).
 */
export function automationTitle(
  automation: Pick<AutomationDefinition, 'name' | 'objective'>,
): string {
  const name = automation.name?.trim();
  return name ? name : automation.objective;
}

export function actorLabel(
  selection: AutomationActorSelection,
  agentName: (agentId: string) => string,
  legacy = false,
): string {
  if (selection.mode === 'fixed') {
    return selection.agentId ? agentName(selection.agentId) : 'No agent assigned';
  }
  if (selection.eligibleAgentIds.length === 0) {
    return legacy ? 'Alia (legacy routine)' : 'No eligible agents';
  }
  return selection.eligibleAgentIds.map(agentName).join(', ');
}

export function resourceLabel(resource: AutomationResource): string {
  return [
    resource.appId,
    resource.effectiveAccountId,
    `${resource.resourceType}/${resource.resourceId}`,
  ].join(' · ');
}

export function latestRunsByAutomation(runs: readonly AutomationRun[]): Map<string, AutomationRun> {
  const latest = new Map<string, AutomationRun>();
  for (const run of runs) {
    const current = latest.get(run.automationId);
    if (!current || Date.parse(run.startedAt) > Date.parse(current.startedAt)) {
      latest.set(run.automationId, run);
    }
  }
  return latest;
}

export function policyReason(run: AutomationRun | undefined): string | null {
  return decisionReason(run?.policyDecision);
}

export function decisionReason(decision: Record<string, unknown> | null | undefined): string | null {
  const reason = decision?.reason;
  return typeof reason === 'string' ? humanizeIdentifier(reason) : null;
}

export function canRunNow(
  automation: Pick<AutomationDefinition, 'legacyTriggerId' | 'trigger'>,
): boolean {
  return Boolean(automation.legacyTriggerId) || automation.trigger.type !== 'event';
}
