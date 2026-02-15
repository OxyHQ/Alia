/**
 * Log Observer
 * Pino-backed implementation of the Observer interface.
 * Records all events as structured pino logs for production use.
 */

import { createLogger } from '../logger.js';
import type { Observer, ObserverEvent, ObserverMetric } from './types.js';

const obsLog = createLogger('observability');

export class LogObserver implements Observer {
  name = 'log';

  recordEvent(event: ObserverEvent): void {
    const { type, timestamp, ...data } = event;

    switch (type) {
      case 'agent.start':
        obsLog.info({ eventType: type, ...data }, 'agent.start');
        break;
      case 'agent.end':
        if (event.error) {
          obsLog.warn({ eventType: type, ...data }, 'agent.end (failed)');
        } else {
          obsLog.info({ eventType: type, ...data }, 'agent.end');
        }
        break;
      case 'tool.call':
        obsLog.info({ eventType: type, ...data }, `tool.call.${event.toolName}`);
        break;
      case 'error':
        obsLog.error({ eventType: type, ...data }, 'error');
        break;
      default:
        obsLog.info({ eventType: type, ...data }, type);
    }
  }

  recordMetric(metric: ObserverMetric): void {
    obsLog.info(
      { metric: metric.name, value: metric.value, ...metric.labels },
      `metric.${metric.name}`,
    );
  }

  async flush(): Promise<void> {
    // pino auto-flushes; nothing to do
  }
}
