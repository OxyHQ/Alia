/** Typed task envelope persisted for each deterministic automation stage. */

import { z } from 'zod';
import type { AutomationDefinitionRecord } from '../db/automation/automationDefinitionRepository.js';
import type { AutomationDispatchTrigger } from './automation-dispatcher.js';
import type { AutomationStagePlan } from './automation-coordination.js';
import { sameAutomationResource } from './automation-coordination.js';

const resourceSchema = z.object({
  appId: z.string(),
  effectiveAccountId: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
}).strict();

const taskInputSchema = z.object({
  objective: z.string(),
  trigger: z.record(z.unknown()),
  inputs: z.record(z.unknown()),
  actions: z.array(z.object({
    resource: resourceSchema,
    tool: z.string(),
    input: z.record(z.unknown()),
  }).strict()),
  receivePreviousResult: z.boolean(),
}).strict();

export type AutomationStageTaskInput = z.infer<typeof taskInputSchema>;

function triggerContext(trigger: AutomationDispatchTrigger): Record<string, unknown> {
  if (trigger.kind === 'event') {
    return {
      type: 'event',
      eventId: trigger.id,
      appId: trigger.appId,
      eventType: trigger.eventType,
      occurredAt: trigger.occurredAt.toISOString(),
      resource: trigger.resource,
      data: trigger.data,
    };
  }
  if (trigger.kind === 'schedule') {
    return {
      type: 'schedule',
      occurrenceId: trigger.id,
      occurredAt: trigger.occurredAt.toISOString(),
    };
  }
  return {
    type: 'manual',
    occurredAt: trigger.occurredAt.toISOString(),
  };
}

function receivesPreviousResult(
  automation: AutomationDefinitionRecord,
  previous: AutomationStagePlan | undefined,
  current: AutomationStagePlan,
): boolean {
  if (!previous) return false;
  const previousReadsDeclaredSource = previous.actions.some((action) => (
    automation.dataFlow.sources.some((source) => sameAutomationResource(source, action.resource))
  ));
  const currentWritesDeclaredDestination = current.actions.some((action) => (
    automation.dataFlow.destinations.some((destination) => (
      sameAutomationResource(destination, action.resource)
    ))
  ));
  return previousReadsDeclaredSource && currentWritesDeclaredDestination;
}

export function automationStageTaskInputs(
  automation: AutomationDefinitionRecord,
  trigger: AutomationDispatchTrigger,
  stages: readonly AutomationStagePlan[],
): AutomationStageTaskInput[] {
  return stages.map((stage, index) => ({
    objective: automation.objective,
    trigger: index === 0 ? triggerContext(trigger) : { type: 'prior_stage' },
    inputs: automation.inputs,
    actions: stage.actions.map((action) => ({
      resource: action.resource,
      tool: action.tool,
      input: action.input,
    })),
    receivePreviousResult: receivesPreviousResult(automation, stages[index - 1], stage),
  }));
}

export function renderAutomationStageTask(
  rawInput: Record<string, unknown>,
  previousResult?: string | null,
): string {
  const input = taskInputSchema.parse(rawInput);
  const context: Record<string, unknown> = {
    trigger: input.trigger,
    inputs: input.inputs,
    actions: input.actions,
  };
  if (input.receivePreviousResult && previousResult) {
    context.previousStageResult = previousResult.slice(0, 8_000);
  }
  return [
    input.objective,
    '',
    'This run was started by a normalized Oxy automation. Use only the declared actions and minimum context below.',
    JSON.stringify(context),
  ].join('\n');
}
