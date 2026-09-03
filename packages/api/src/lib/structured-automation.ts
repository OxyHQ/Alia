import type { AutomationDefinitionRecord } from '../db/automation/automationDefinitionRepository.js';

/** User-editable receipt returned by both HTTP and conversational creation. */
export function automationReceipt(automation: AutomationDefinitionRecord) {
  return {
    objective: automation.objective,
    trigger: automation.trigger,
    actors: automation.actorSelection,
    executionMode: automation.executionMode,
    actions: automation.actions,
    resources: automation.resources,
    dataFlow: automation.dataFlow,
    maximumAutonomy: automation.maximumAutonomy,
    limits: automation.limits,
    enabled: automation.enabled,
    undo: { method: 'DELETE' as const, path: `/automations/${automation.id}` },
  };
}
