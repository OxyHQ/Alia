/**
 * Tracing — Lightweight Span-Based Tracing for Agent Sessions
 *
 * Provides OpenTelemetry-compatible span structure without requiring
 * the full OTel SDK. Traces can be exported to any compatible backend.
 *
 * Each agent session creates a root span with child spans for:
 *   - Model calls (LLM inference)
 *   - Tool calls
 *   - Container operations
 *   - Context compaction
 */

import crypto from 'crypto';
import { log } from '../logger.js';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, string | number>;
}

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Trace context for an agent session.
 * Creates root and child spans for the session's operations.
 */
export class SessionTrace {
  private traceId: string;
  private rootSpan: Span;
  private spans: Span[] = [];

  constructor(sessionId: string, opts?: { agentId?: string; userId?: string; task?: string }) {
    this.traceId = generateTraceId();

    this.rootSpan = {
      traceId: this.traceId,
      spanId: generateId(),
      operationName: 'agent.session',
      startTime: Date.now(),
      status: 'unset',
      attributes: {
        'session.id': sessionId,
        ...(opts?.agentId ? { 'agent.id': opts.agentId } : {}),
        ...(opts?.userId ? { 'user.id': opts.userId } : {}),
        ...(opts?.task ? { 'session.task': opts.task.slice(0, 200) } : {}),
      },
      events: [],
    };
    this.spans.push(this.rootSpan);
  }

  /** Start a child span */
  startSpan(operationName: string, attributes?: Record<string, string | number | boolean>): Span {
    const span: Span = {
      traceId: this.traceId,
      spanId: generateId(),
      parentSpanId: this.rootSpan.spanId,
      operationName,
      startTime: Date.now(),
      status: 'unset',
      attributes: attributes || {},
      events: [],
    };
    this.spans.push(span);
    return span;
  }

  /** End a span */
  endSpan(span: Span, status: 'ok' | 'error' = 'ok', error?: string): void {
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = status;
    if (error) {
      span.attributes['error.message'] = error;
      span.events.push({ name: 'exception', timestamp: Date.now(), attributes: { 'exception.message': error } });
    }
  }

  /** Add an event to the root span */
  addEvent(name: string, attributes?: Record<string, string | number>): void {
    this.rootSpan.events.push({ name, timestamp: Date.now(), attributes });
  }

  /** End the session trace */
  end(status: 'ok' | 'error' = 'ok', summary?: Record<string, string | number>): void {
    if (summary) {
      Object.assign(this.rootSpan.attributes, summary);
    }
    this.endSpan(this.rootSpan, status);

    log.agents.info({
      traceId: this.traceId,
      spans: this.spans.length,
      durationMs: this.rootSpan.durationMs,
      status,
    }, 'Session trace completed');
  }

  /** Export all spans (for sending to tracing backend) */
  exportSpans(): Span[] {
    return this.spans.map(s => ({ ...s }));
  }

  /** Get the trace ID */
  getTraceId(): string {
    return this.traceId;
  }

  /** Get the root span ID (for child traces) */
  getRootSpanId(): string {
    return this.rootSpan.spanId;
  }
}
