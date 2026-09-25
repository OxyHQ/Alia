import type {
  AutomationDefinition,
  AutomationResource,
  AutomationUpdateActorSelection,
  AutomationUpdateInput,
  AutomationUpdateTrigger,
} from './types';

export interface AutomationLimitDraft {
  key: string;
  value: string;
}

export interface AutomationEditDraft {
  objective: string;
  instructions: string;
  trigger: AutomationUpdateTrigger;
  actorSelection: AutomationUpdateActorSelection;
  resources: AutomationResource[];
  dataFlow: { sources: AutomationResource[]; destinations: AutomationResource[] };
  maximumAutonomy: AutomationUpdateInput['maximumAutonomy'];
  limits: AutomationLimitDraft[];
  enabled: boolean;
}

/**
 * `error` is an i18n key (with `params` for the ones that name a limit), so
 * the editor's toast is in the reader's language; it was English text.
 */
export type AutomationEditResult =
  | { ok: true; value: AutomationUpdateInput }
  | { ok: false; error: string; params?: Record<string, string> };

function copyResource(resource: AutomationResource): AutomationResource {
  return { ...resource };
}

function editableTrigger(trigger: AutomationDefinition['trigger']): AutomationUpdateTrigger {
  if (trigger.type === 'schedule') {
    return {
      type: 'schedule',
      cron: trigger.cron ?? '',
      timezone: trigger.timezone ?? '',
    };
  }
  if (trigger.type === 'event') {
    return {
      type: 'event',
      appId: trigger.appId ?? '',
      eventType: trigger.eventType ?? '',
      ...(trigger.resource ? { resource: copyResource(trigger.resource) } : {}),
    };
  }
  return { type: 'manual' };
}

function editableActor(
  actorSelection: AutomationDefinition['actorSelection'],
): AutomationUpdateActorSelection {
  return actorSelection.mode === 'fixed'
    ? { mode: 'fixed', agentId: actorSelection.agentId ?? '' }
    : { mode: 'automatic', eligibleAgentIds: [...actorSelection.eligibleAgentIds] };
}

function formatAutomationLimitValue(
  value: string | number | boolean | string[],
): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function createAutomationEditDraft(
  automation: AutomationDefinition,
): AutomationEditDraft {
  return {
    objective: automation.objective,
    instructions: typeof automation.inputs?.instructions === 'string'
      ? automation.inputs.instructions
      : automation.objective,
    trigger: editableTrigger(automation.trigger),
    actorSelection: editableActor(automation.actorSelection),
    resources: automation.resources.map(copyResource),
    dataFlow: {
      sources: automation.dataFlow.sources.map(copyResource),
      destinations: automation.dataFlow.destinations.map(copyResource),
    },
    maximumAutonomy: automation.maximumAutonomy,
    limits: automation.limits.map((limit) => ({
      key: limit.key,
      value: formatAutomationLimitValue(limit.value),
    })),
    enabled: automation.enabled,
  };
}

function validResource(resource: AutomationResource): boolean {
  return [
    resource.appId,
    resource.effectiveAccountId,
    resource.resourceType,
    resource.resourceId,
  ].every((value) => value.trim().length > 0);
}

function cleanResource(resource: AutomationResource): AutomationResource {
  return {
    appId: resource.appId.trim(),
    effectiveAccountId: resource.effectiveAccountId.trim(),
    resourceType: resource.resourceType.trim(),
    resourceId: resource.resourceId.trim(),
  };
}

function parseLimitValue(value: string): AutomationUpdateInput['limits'][number]['value'] | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean') {
      return parsed;
    }
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed;
    }
    return null;
  } catch {
    return trimmed;
  }
}

export function buildAutomationUpdate(draft: AutomationEditDraft): AutomationEditResult {
  const objective = draft.objective.trim();
  if (!objective) return { ok: false, error: 'automations.edit.objectiveRequired' };
  if (!draft.instructions.trim()) return { ok: false, error: 'automations.edit.instructionsRequired' };
  if (draft.trigger.type === 'schedule'
    && (!draft.trigger.cron.trim() || !draft.trigger.timezone.trim())) {
    return { ok: false, error: 'automations.edit.scheduleRequired' };
  }
  if (draft.trigger.type === 'event'
    && (!draft.trigger.appId.trim() || !draft.trigger.eventType.trim())) {
    return { ok: false, error: 'automations.edit.eventRequired' };
  }
  if (draft.trigger.type === 'event' && draft.trigger.resource
    && !validResource(draft.trigger.resource)) {
    return { ok: false, error: 'automations.edit.eventResourceIncomplete' };
  }
  if (draft.actorSelection.mode === 'fixed' && !draft.actorSelection.agentId.trim()) {
    return { ok: false, error: 'automations.edit.chooseAgent' };
  }
  if (draft.actorSelection.mode === 'automatic'
    && draft.actorSelection.eligibleAgentIds.length === 0) {
    return { ok: false, error: 'automations.edit.chooseEligibleAgent' };
  }
  const resources = [
    ...draft.resources,
    ...draft.dataFlow.sources,
    ...draft.dataFlow.destinations,
  ];
  if (!resources.every(validResource)) {
    return { ok: false, error: 'automations.edit.resourceIncomplete' };
  }

  const limits: AutomationUpdateInput['limits'] = [];
  const limitKeys = new Set<string>();
  for (const limit of draft.limits) {
    const key = limit.key.trim();
    if (!key) return { ok: false, error: 'automations.edit.limitKeyRequired' };
    if (limitKeys.has(key)) return { ok: false, error: 'automations.edit.limitDuplicated', params: { key } };
    limitKeys.add(key);
    const value = parseLimitValue(limit.value);
    if (value === null) {
      return { ok: false, error: 'automations.edit.limitInvalid', params: { key } };
    }
    limits.push({ key, value });
  }

  return {
    ok: true,
    value: {
      objective,
      instructions: draft.instructions.trim(),
      trigger: draft.trigger.type === 'schedule'
        ? {
            type: 'schedule',
            cron: draft.trigger.cron.trim(),
            timezone: draft.trigger.timezone.trim(),
          }
        : draft.trigger.type === 'event'
          ? {
              type: 'event',
              appId: draft.trigger.appId.trim(),
              eventType: draft.trigger.eventType.trim(),
              ...(draft.trigger.resource ? { resource: cleanResource(draft.trigger.resource) } : {}),
            }
          : { type: 'manual' },
      actorSelection: draft.actorSelection.mode === 'fixed'
        ? { mode: 'fixed', agentId: draft.actorSelection.agentId.trim() }
        : {
            mode: 'automatic',
            eligibleAgentIds: draft.actorSelection.eligibleAgentIds.map((agentId) => agentId.trim()),
          },
      resources: draft.resources.map(cleanResource),
      dataFlow: {
        sources: draft.dataFlow.sources.map(cleanResource),
        destinations: draft.dataFlow.destinations.map(cleanResource),
      },
      maximumAutonomy: draft.maximumAutonomy,
      limits,
      enabled: draft.enabled,
    },
  };
}
