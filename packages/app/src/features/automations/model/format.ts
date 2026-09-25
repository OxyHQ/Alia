import type {
  AutomationActorSelection,
  AutomationDefinition,
  AutomationResource,
  AutomationRun,
  Translate,
} from '@/shared/contracts/automations';

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

export function actorLabel(
  selection: AutomationActorSelection,
  agentName: (agentId: string) => string,
  t: Translate,
): string {
  if (selection.mode === 'fixed') {
    return selection.agentId ? agentName(selection.agentId) : t('automations.actor.none');
  }
  if (selection.eligibleAgentIds.length === 0) {
    return t('automations.actor.noEligible');
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

/**
 * A run's status in words. The union is the API's; a status it adds later
 * reads as its humanized identifier until it has words of its own here.
 */
const RUN_STATUSES: ReadonlySet<string> = new Set([
  'planned',
  'running',
  'observed',
  'succeeded',
  'failed',
  'cancelled',
  'denied',
]);

export function runStatusLabel(status: string, t: Translate): string {
  return RUN_STATUSES.has(status) ? t(`automations.runStatus.${status}`) : humanizeIdentifier(status);
}

export function policyReason(run: AutomationRun | undefined): string | null {
  return decisionReason(run?.policyDecision);
}

function decisionReason(decision: Record<string, unknown> | null | undefined): string | null {
  const reason = decision?.reason;
  return typeof reason === 'string' ? humanizeIdentifier(reason) : null;
}

export function canRunNow(
  automation: Pick<AutomationDefinition, 'trigger'>,
): boolean {
  return automation.trigger.type !== 'event';
}
