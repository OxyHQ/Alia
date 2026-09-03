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
  resources: AutomationResource[];
  dataFlow: { sources: AutomationResource[]; destinations: AutomationResource[] };
  maximumAutonomy: AutomationAutonomy;
  limits: Array<{ key: string; value: string | number | boolean | string[] }>;
  enabled: boolean;
  legacyTriggerId: string | null;
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
  trigger: AutomationUpdateTrigger;
  actorSelection: AutomationUpdateActorSelection;
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

export interface LegacyAutomationCreateInput {
  name: string;
  type: 'schedule';
  action: { prompt: string; useTools: boolean };
  schedule:
    | { type: 'daily'; time: string; days: string[] }
    | { type: 'interval'; intervalMinutes: number };
}
