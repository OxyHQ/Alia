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
  /**
   * The name the person typed when creating it, or null.
   *
   * Legacy-trigger automations require a name at creation and the index used
   * to drop it, so lists and history showed the prompt as the heading and two
   * automations with the same prompt were indistinguishable (#534). The API
   * joins it back from the trigger; structured definitions have no name of
   * their own and carry null. Render with `automationTitle`, never `name!`.
   */
  name: string | null;
  objective: string;
  trigger: AutomationTrigger;
  actorSelection: AutomationActorSelection;
  executionMode: AutomationExecutionMode;
  actions: AutomationAction[];
  resources: AutomationResource[];
  dataFlow: { sources: AutomationResource[]; destinations: AutomationResource[] };
  maximumAutonomy: AutomationAutonomy;
  limits: Array<{ key: string; value: string | number | boolean | string[] }>;
  enabled: boolean;
  legacyTriggerId: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface LegacyAutomationCreateInput {
  name: string;
  type: 'schedule';
  action: { prompt: string; useTools: boolean };
  schedule:
    | { type: 'daily'; time: string; days: string[] }
    | { type: 'interval'; intervalMinutes: number };
}
