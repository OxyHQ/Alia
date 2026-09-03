export const CHAT_EVENT_VERSION = 1;

export type AliaChatEventName =
  | 'alia.plan_preview'
  | 'alia.approval_request'
  | 'alia.approval_result'
  | 'alia.research_progress'
  | 'alia.agent_session'
  | 'alia.reasoning'
  | 'alia.tool_result'
  | 'alia.title'
  | 'alia.model_switch';

export interface PlanPreviewEvent {
  eventVersion: typeof CHAT_EVENT_VERSION;
  planId: string;
  intent: string;
  confidence: number;
  steps: string[];
}

export interface ApprovalRequestEvent {
  eventVersion: typeof CHAT_EVENT_VERSION;
  requestId: string;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  severity: string;
  timeout: number;
}

export interface ApprovalResultEvent {
  eventVersion: typeof CHAT_EVENT_VERSION;
  requestId: string;
  decision: 'approved' | 'denied' | 'timeout';
}
