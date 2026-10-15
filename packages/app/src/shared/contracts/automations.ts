export type AutomationAutonomy = 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
export type AutomationExecutionMode = 'observe' | 'execute';

// The trigger of a scheduled task is drawn in the chat thread (its card), so the SDK owns the type.
export type { AutomationResource, AutomationTrigger } from '@alia.onl/sdk/runtime';
import type { AutomationResource, AutomationTrigger } from '@alia.onl/sdk/model';

export interface AutomationAction {
  id: string;
  position: number;
  resource: AutomationResource;
  tool: string;
  input: Record<string, unknown>;
  limits: Array<{ key: string; value: number | boolean }>;
}

/** Who is responsible for a task: Alia by default, or one or more of the person's agents. */
export type AutomationActorSelection =
  | { mode: 'alia' }
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
  /** The Alia conversation an Alia task's results land in, once one has. */
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AutomationUpdateTrigger =
  | { type: 'manual' }
  | { type: 'event'; appId: string; eventType: string; resource?: AutomationResource }
  | { type: 'schedule'; cron: string; timezone: string };

export type AutomationUpdateActorSelection =
  | { mode: 'alia' }
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
// An automation's trigger is shown by the automations screens AND by the thread's tool card when
// an agent creates one, so the SDK owns the words along with the type.
export { cronLabel, triggerLabel } from '@alia.onl/sdk/model';
export type { Translate } from '@alia.onl/sdk/model';
