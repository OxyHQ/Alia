/**
 * Observability Types
 * Inspired by ZeroClaw's ObserverEvent / ObserverMetric pattern.
 * Typed events for agent lifecycle, tool calls, and errors.
 */

// ── Event Types ──

export interface AgentStartEvent {
  type: 'agent.start';
  timestamp: number;
  modelId?: string;
  provider?: string;
  userId?: string;
  conversationId?: string;
  platform?: string;
}

export interface AgentEndEvent {
  type: 'agent.end';
  timestamp: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCallCount?: number;
  error?: string;
}

export interface ToolCallEvent {
  type: 'tool.call';
  timestamp: number;
  toolName: string;
  durationMs: number;
  success: boolean;
  resultSizeChars?: number;
}

export interface ErrorEvent {
  type: 'error';
  timestamp: number;
  code?: string;
  message: string;
}

export type ObserverEvent =
  | AgentStartEvent
  | AgentEndEvent
  | ToolCallEvent
  | ErrorEvent;

// ── Metric Types ──

export interface ObserverMetric {
  name: string;
  value: number;
  labels?: Record<string, string>;
  timestamp?: number;
}

// ── Observer Interface ──

export interface Observer {
  name: string;
  recordEvent(event: ObserverEvent): void;
  recordMetric(metric: ObserverMetric): void;
  flush(): Promise<void>;
}
