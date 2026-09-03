import { beforeEach, describe, expect, it } from 'vitest';

import {
  checkInfiniteLoop,
  checkSessionRunaway,
  cleanupSessionAlerts,
  onAlert,
  type Alert,
} from '../alerts.js';

/**
 * `lib/observability/alerts.ts` emits, and a registered handler hears it.
 *
 * ## Why this file did not exist, and what that cost
 *
 * `emit()` logged through a DETACHED pino method:
 *
 * ```ts
 * const logFn = level === 'critical' ? log.agents.error : log.agents.warn;
 * logFn({ alert: type, ...metadata }, `ALERT: ${message}`);
 * ```
 *
 * pino's level methods live on the child logger's prototype and read `this`, so
 * calling one off a `const` throws `undefined is not an object (evaluating
 * 'this[msgPrefixSym]')`. Every alert this module has ever produced therefore
 * threw at that line — AFTER pushing to `recentAlerts` and BEFORE the handler
 * loop — so `getRecentAlerts()` filled up and **no `onAlert` handler has ever
 * run**. None of the three checks had a caller, which is exactly why nothing
 * noticed: an alerting module with no callers and no tests is a mechanism whose
 * brokenness is unobservable.
 *
 * The ordering is what makes the handler assertion below the load-bearing one.
 * A test that only read `getRecentAlerts()` would have passed against the broken
 * version, because the push happens first.
 */

const raised: Alert[] = [];
onAlert((alert) => raised.push(alert));

beforeEach(() => {
  raised.length = 0;
});

describe('emit reaches a registered handler, not just the ring buffer', () => {
  it('delivers a warning alert too, which is the other branch of the level check', () => {
    // Both arms, because the fix replaced one expression with an `if`/`else` and
    // a test of one arm says nothing about the other.
    checkSessionRunaway('alerts-session-1', 900_000);

    expect(raised).toHaveLength(1);
    expect(raised[0]?.level).toBe('warning');
    expect(raised[0]?.type).toBe('session_runaway');
  });

  it('delivers the third check, whose metadata comes from a tool call', () => {
    const args = { path: '/etc/passwd' };
    for (let i = 0; i < 3; i += 1) checkInfiniteLoop('alerts-session-2', 'readFile', args);
    cleanupSessionAlerts('alerts-session-2');

    expect(raised).toHaveLength(1);
    expect(raised[0]?.type).toBe('infinite_loop');
    // The signature is built from the arguments and is NOT logged; only the
    // tool name and the session id are. `lib/__tests__/log-content.test.ts`
    // cannot see this call — its root identifier is neither `log` nor a
    // `…Log` — so the absence is asserted here instead.
    expect(raised[0]?.metadata).toEqual({ sessionId: 'alerts-session-2', toolName: 'readFile' });
    expect(JSON.stringify(raised[0]?.metadata)).not.toContain('/etc/passwd');
  });

  it('stays silent when the check does not fire', () => {
    // The discriminator. Without it every assertion above is equally satisfied
    // by a module that alerts on everything.
    checkSessionRunaway('alerts-session-3', 1_000);
    checkInfiniteLoop('alerts-session-4', 'readFile', { path: 'a' });
    checkInfiniteLoop('alerts-session-4', 'readFile', { path: 'b' });
    cleanupSessionAlerts('alerts-session-4');

    expect(raised).toEqual([]);
  });

  it('a handler that throws does not stop the ones after it', () => {
    // Reachable: a handler is whatever an operator wired up. `emit` catches per
    // handler, and this is what says so — the second handler running is the
    // property, and it is invisible until the first one throws.
    const heard: string[] = [];
    onAlert(() => {
      throw new Error('handler exploded');
    });
    onAlert((alert) => heard.push(alert.type));

    checkSessionRunaway('alerts-session-5', 900_000);

    expect(heard).toEqual(['session_runaway']);
  });
});
