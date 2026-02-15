/**
 * Observability Module
 * Singleton observer with convenience functions.
 * Default: LogObserver (pino-backed). Swappable for testing or custom backends.
 */

import { LogObserver } from './log-observer.js';
import type { Observer, ObserverEvent, ObserverMetric } from './types.js';

export type {
  Observer,
  ObserverEvent,
  ObserverMetric,
  AgentStartEvent,
  AgentEndEvent,
  ToolCallEvent,
  ErrorEvent,
} from './types.js';

let _observer: Observer = new LogObserver();

export function setObserver(obs: Observer): void {
  _observer = obs;
}

export function getObserver(): Observer {
  return _observer;
}

/** Record a typed event (agent.start, agent.end, tool.call, error). */
export function recordEvent(event: ObserverEvent): void {
  _observer.recordEvent(event);
}

/** Record a numeric metric with optional labels. */
export function recordMetric(metric: ObserverMetric): void {
  _observer.recordMetric(metric);
}
