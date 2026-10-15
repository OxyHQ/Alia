/**
 * What an agent's run is doing, as data: the events it emits, and the state they add up to.
 *
 * Pure. `use-agent-activity.ts` subscribes to the run and feeds `applyActivityEvent` with what
 * arrives; `hydrateActivity` seeds the state from what the run had already done when the screen
 * opened. Both the live card in the thread and a task's timeline read the result.
 */

export interface PlanItem {
  id: number;
  text: string;
  status: string;
}

export interface PlanProgress {
  items: PlanItem[];
  completed: number;
  total: number;
}

export type AgentActivityEventType =
  | 'system'
  | 'thinking'
  | 'response'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'complete'
  | 'screenshot'
  | 'plan_progress'
  | 'file_change'
  | 'source_found'
  | 'threat'
  | 'approval_request'
  | 'approval_result';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

export interface AgentActivityEvent {
  type: AgentActivityEventType;
  content: string;
  timestamp: number;
  sessionId: string;
  agentId?: string;
  metadata?: {
    toolName?: string;
    /** What the tool was called with; the browser tool's `action`, `url` and `query`, a plan's `action`, a delegate's `agent`. */
    args?: {
      action?: string;
      url?: string;
      query?: string;
      agent?: string;
      [key: string]: unknown;
    };
    duration?: number;
    url?: string;
    title?: string;
    domain?: string;
    requestId?: string;
    decision?: ApprovalDecision;
  };
  data?: {
    url?: string;
    plan?: PlanProgress;
    currentStep?: number;
    maxSteps?: number;
    approval?: {
      requestId: string;
      toolName: string;
      args: Record<string, unknown>;
      description: string;
      severity: string;
      timeout: number;
    };
  };
}

export interface AgentSource {
  url: string;
  title: string;
  domain: string;
  snippet: string;
  timestamp: number;
}

export interface AgentApprovalRequest {
  requestId: string;
  toolName: string;
  description: string;
  severity: string;
  timeout: number;
  args?: Record<string, unknown>;
}

export interface AgentActivityState {
  /** Current plan with checklist items */
  plan: PlanProgress | null;
  /** Current action being executed */
  currentAction: { toolName: string; content: string } | null;
  /** Whether the agent has completed */
  isComplete: boolean;
  /** Whether there's an error */
  hasError: boolean;
  /** Last error message */
  lastError: string | null;
  /** Total events received */
  eventCount: number;
  /** All activity events (last 50) */
  events: AgentActivityEvent[];
  /** Start time of first event */
  startedAt: number | null;
  /** Sources found during browsing */
  sources: AgentSource[];
  /** Latest text response from agent */
  latestResponse: string | null;
  /** Pending approval request for this session */
  approvalRequest: AgentApprovalRequest | null;
  /** Last approval decision */
  approvalResult: { requestId: string; decision: ApprovalDecision } | null;
  /** Total credits charged for this session (present once the run settles) */
  creditsCharged?: number;
}

export const INITIAL_ACTIVITY: AgentActivityState = {
  plan: null,
  currentAction: null,
  isComplete: false,
  hasError: false,
  lastError: null,
  eventCount: 0,
  events: [],
  startedAt: null,
  sources: [],
  latestResponse: null,
  approvalRequest: null,
  approvalResult: null,
};

/** How many events the state keeps. */
export const MAX_ACTIVITY_EVENTS = 50;

/** Add one event to the run's state. */
export function applyActivityEvent(
  prev: AgentActivityState,
  event: AgentActivityEvent,
): AgentActivityState {
  const next: AgentActivityState = {
    ...prev,
    eventCount: prev.eventCount + 1,
    events: [...prev.events.slice(-(MAX_ACTIVITY_EVENTS - 1)), event],
    startedAt: prev.startedAt ?? event.timestamp,
  };

  switch (event.type) {
    case 'plan_progress':
      if (event.data?.plan) next.plan = event.data.plan;
      break;

    case 'tool_call':
      next.currentAction = {
        toolName: event.metadata?.toolName || 'action',
        content: event.content,
      };
      break;

    case 'tool_result':
      next.currentAction = null;
      break;

    case 'error':
      next.hasError = true;
      next.lastError = event.content;
      next.currentAction = null;
      break;

    case 'complete':
      next.isComplete = true;
      next.currentAction = null;
      next.latestResponse = null;
      break;

    case 'source_found': {
      const url = event.metadata?.url;
      if (url && !prev.sources.some((source) => source.url === url)) {
        next.sources = [
          ...prev.sources,
          {
            url,
            title: event.metadata?.title || '',
            domain: event.metadata?.domain || new URL(url).hostname,
            snippet: event.content?.slice(0, 200) || '',
            timestamp: event.timestamp,
          },
        ];
      }
      break;
    }

    case 'response':
      next.latestResponse = event.content;
      break;

    case 'approval_request':
      if (event.data?.approval) {
        const { requestId, toolName, description, severity, timeout, args } = event.data.approval;
        next.approvalRequest = { requestId, toolName, description, severity, timeout, args };
      }
      break;

    case 'approval_result':
      if (event.metadata?.requestId && event.metadata?.decision) {
        next.approvalResult = {
          requestId: event.metadata.requestId,
          decision: event.metadata.decision,
        };
      }
      next.approvalRequest = null;
      break;
  }

  return next;
}

/** An event as the session-status route stores it. */
interface PersistedAgentEvent {
  type: string;
  content: string;
  timestamp: number;
  metadata?: AgentActivityEvent['metadata'];
}

/** What `GET` on a session's status answers. */
export interface AgentSessionStatus {
  recentEvents?: PersistedAgentEvent[];
  session?: {
    plan?: { items?: PlanItem[] };
    status?: string;
    result?: string;
    stats?: { creditsCharged?: number };
  };
}

function eventTypeOf(type: string): AgentActivityEventType {
  switch (type) {
    case 'action':
      return 'tool_call';
    case 'observation':
      return 'tool_result';
    case 'threat_detected':
      return 'threat';
    case 'thinking':
    case 'response':
    case 'error':
    case 'complete':
    case 'screenshot':
    case 'plan_progress':
    case 'file_change':
    case 'source_found':
      return type;
    // `user_message`, `system_message`, `plan_update` and anything newer.
    default:
      return 'system';
  }
}

/** Seed the state with what the run had done before this screen subscribed to it. */
export function hydrateActivity(
  prev: AgentActivityState,
  status: AgentSessionStatus,
  sessionId: string,
): AgentActivityState {
  const events = (Array.isArray(status.recentEvents) ? status.recentEvents : [])
    .map(
      (entry): AgentActivityEvent => ({
        type: eventTypeOf(entry.type),
        content: entry.content,
        timestamp: entry.timestamp,
        sessionId,
        metadata: entry.metadata,
      }),
    )
    .slice(-MAX_ACTIVITY_EVENTS);
  const session = status.session;
  const planItems = Array.isArray(session?.plan?.items) ? session.plan.items : [];
  const failed = session?.status === 'failed';
  const credits = session?.stats?.creditsCharged;

  return {
    ...prev,
    events,
    eventCount: events.length,
    startedAt: events[0]?.timestamp || prev.startedAt,
    plan:
      planItems.length > 0
        ? {
            items: planItems,
            completed: planItems.filter((item) => item.status === 'completed').length,
            total: planItems.length,
          }
        : prev.plan,
    isComplete: session?.status === 'completed' || session?.status === 'cancelled',
    hasError: failed,
    lastError: failed ? session?.result || prev.lastError : prev.lastError,
    latestResponse: session?.result || prev.latestResponse,
    creditsCharged: typeof credits === 'number' ? credits : prev.creditsCharged,
  };
}
