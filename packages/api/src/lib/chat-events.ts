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
  | 'alia.model_switch'
  | 'alia.deprecation';

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

/**
 * The compatibility window's stream-side signal, named by
 * `docs/migration/compatibility-window.md` — *"a product stream event.
 * `alia.deprecation`, following the existing `alia.*` SSE convention with
 * `eventVersion: 1`, carrying the deprecated identifier, its replacement, and
 * the sunset date where one is set."*
 *
 * The headers are the other half and reach every response
 * (`middleware/alias-deprecation.ts`); this reaches a streaming caller that
 * reads the body and never inspects headers, which is most SDK users.
 */
export interface DeprecationEvent {
  eventVersion: typeof CHAT_EVENT_VERSION;
  /** The deprecated identifier this request named. */
  identifier: string;
  /** What it becomes under ADR 0003: a routing profile id, never a model id. */
  replacement: string;
  /** When the deprecation took effect. */
  deprecatedAt: string;
  /** The removal date, or `null` while none is set. A date here is a commitment. */
  sunsetAt: string | null;
  /** Where a caller reads what to do about it. */
  documentation: string;
}
