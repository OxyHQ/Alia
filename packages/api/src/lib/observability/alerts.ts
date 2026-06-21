/**
 * Alerts — Runtime Anomaly Detection for Agent Platform
 *
 * Monitors for dangerous patterns:
 *   - Budget exhaustion (credits/tokens running low)
 *   - Provider failure cascades (multiple keys failing)
 *   - Infinite loops (agent repeating same action)
 *   - Session runaway (session running too long)
 */

import { log } from '../logger.js';

export interface Alert {
  id: string;
  level: 'warning' | 'critical';
  type: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

type AlertHandler = (alert: Alert) => void;

const alertHandlers: AlertHandler[] = [];
const recentAlerts: Alert[] = [];
const MAX_RECENT_ALERTS = 100;
let alertSeq = 0;

/** Register a handler for alerts (e.g. log, webhook, Slack) */
export function onAlert(handler: AlertHandler): void {
  alertHandlers.push(handler);
}

/** Emit an alert */
function emit(level: Alert['level'], type: string, message: string, metadata?: Record<string, unknown>): void {
  const alert: Alert = {
    id: `alert-${++alertSeq}`,
    level,
    type,
    message,
    timestamp: Date.now(),
    metadata,
  };

  recentAlerts.push(alert);
  if (recentAlerts.length > MAX_RECENT_ALERTS) {
    recentAlerts.shift();
  }

  // Log the alert
  const logFn = level === 'critical' ? log.agents.error : log.agents.warn;
  logFn({ alert: type, ...metadata }, `ALERT: ${message}`);

  // Notify handlers
  for (const handler of alertHandlers) {
    try {
      handler(alert);
    } catch { /* don't let handler errors break alerting */ }
  }
}

/** Get recent alerts */
export function getRecentAlerts(limit = 50): Alert[] {
  return recentAlerts.slice(-limit);
}

// ── Specific Alert Checks ──

/**
 * Check for infinite loop: agent calling the same tool with same args repeatedly.
 */
const recentActions = new Map<string, string[]>(); // sessionId -> recent action signatures

export function checkInfiniteLoop(sessionId: string, toolName: string, args: Record<string, unknown>): boolean {
  const signature = `${toolName}:${JSON.stringify(args).slice(0, 200)}`;

  if (!recentActions.has(sessionId)) {
    recentActions.set(sessionId, []);
  }
  const actions = recentActions.get(sessionId)!;
  actions.push(signature);

  // Keep last 10 actions
  if (actions.length > 10) actions.shift();

  // Check if last 3 actions are identical
  if (actions.length >= 3) {
    const last3 = actions.slice(-3);
    if (last3[0] === last3[1] && last3[1] === last3[2]) {
      emit('warning', 'infinite_loop', `Agent repeating same action: ${toolName}`, { sessionId, toolName });
      return true;
    }
  }

  return false;
}

/**
 * Check for provider failure cascade.
 */
export function checkProviderCascade(failedKeyCount: number, totalKeyCount: number): void {
  if (totalKeyCount === 0) return;
  const failureRate = failedKeyCount / totalKeyCount;
  if (failureRate > 0.5) {
    emit('critical', 'provider_cascade', `${Math.round(failureRate * 100)}% of provider keys have failed (${failedKeyCount}/${totalKeyCount})`, {
      failedKeyCount,
      totalKeyCount,
    });
  }
}

/**
 * Check for session runaway (exceeding expected duration).
 */
export function checkSessionRunaway(sessionId: string, durationMs: number, maxExpectedMs = 600_000): void {
  if (durationMs > maxExpectedMs) {
    emit('warning', 'session_runaway', `Session running for ${Math.round(durationMs / 60000)}min (expected max ${Math.round(maxExpectedMs / 60000)}min)`, {
      sessionId,
      durationMs,
    });
  }
}

/**
 * Clean up alert state for a completed session.
 */
export function cleanupSessionAlerts(sessionId: string): void {
  recentActions.delete(sessionId);
}
