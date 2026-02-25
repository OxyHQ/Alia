/**
 * MCP Health — Connection Health Monitoring
 *
 * Tracks the health of MCP server connections and provides
 * auto-reconnect logic for flaky connections.
 */

import { log } from '../logger.js';

export interface ServerHealth {
  serverId: string;
  serverName: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastPingAt: number;
  lastErrorAt: number;
  errorCount: number;
  /** Consecutive successful calls */
  successStreak: number;
  /** Average response time (ms) */
  avgResponseMs: number;
}

/** Health state per server */
const healthState = new Map<string, ServerHealth>();

/** After this many consecutive errors, mark as unhealthy */
const UNHEALTHY_THRESHOLD = 3;
/** After this many consecutive errors, mark as degraded */
const DEGRADED_THRESHOLD = 1;
/** Response times above this are considered degraded */
const SLOW_RESPONSE_MS = 10_000;

/**
 * Record a successful tool call for a server.
 */
export function recordSuccess(serverId: string, serverName: string, responseMs: number): void {
  const health = getOrCreate(serverId, serverName);
  health.lastPingAt = Date.now();
  health.errorCount = 0;
  health.successStreak++;
  // Exponential moving average for response time
  health.avgResponseMs = health.avgResponseMs === 0
    ? responseMs
    : health.avgResponseMs * 0.8 + responseMs * 0.2;

  health.status = health.avgResponseMs > SLOW_RESPONSE_MS ? 'degraded' : 'healthy';
}

/**
 * Record a failed tool call for a server.
 */
export function recordError(serverId: string, serverName: string, error?: string): void {
  const health = getOrCreate(serverId, serverName);
  health.lastErrorAt = Date.now();
  health.errorCount++;
  health.successStreak = 0;

  if (health.errorCount >= UNHEALTHY_THRESHOLD) {
    health.status = 'unhealthy';
  } else if (health.errorCount >= DEGRADED_THRESHOLD) {
    health.status = 'degraded';
  }

  if (health.status === 'unhealthy') {
    log.general.warn({ serverId, serverName, errorCount: health.errorCount, error }, 'MCP server unhealthy');
  }
}

/**
 * Check if a server is healthy enough to receive tool calls.
 */
export function isServerHealthy(serverId: string): boolean {
  const health = healthState.get(serverId);
  if (!health) return true; // Unknown servers are assumed healthy
  return health.status !== 'unhealthy';
}

/**
 * Get health status for all tracked servers.
 */
export function getAllHealth(): ServerHealth[] {
  return [...healthState.values()];
}

/**
 * Get health status for a specific server.
 */
export function getServerHealth(serverId: string): ServerHealth | undefined {
  return healthState.get(serverId);
}

/**
 * Clear health state for a server (e.g. on reconnect).
 */
export function resetServerHealth(serverId: string): void {
  healthState.delete(serverId);
}

function getOrCreate(serverId: string, serverName: string): ServerHealth {
  let health = healthState.get(serverId);
  if (!health) {
    health = {
      serverId,
      serverName,
      status: 'healthy',
      lastPingAt: 0,
      lastErrorAt: 0,
      errorCount: 0,
      successStreak: 0,
      avgResponseMs: 0,
    };
    healthState.set(serverId, health);
  }
  return health;
}
