/**
 * Agent Infrastructure Health Check
 *
 * Reports which agent capabilities are available based on
 * infrastructure status.
 *
 * `shell` is always false: it meant a reachable sandbox docker host, and there
 * is none — it was never configured in production and is gone.
 *
 * `browser` is always false too, and that is a decision left standing rather
 * than a fact about the browser. It was derived from `shell` ("the browser runs
 * in containers"), so it has answered false in production throughout, and
 * `POST /agents/:id/hire` refuses with 503 when both are false. Deriving it from
 * anything else would open hiring, which is a product change and not part of
 * removing the sandbox.
 */

import { log } from '../logger.js';

export interface AgentCapabilities {
  shell: boolean;
  browser: boolean;
  queue: boolean;
}

let cachedCapabilities: AgentCapabilities | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30_000; // Re-check every 30s

/**
 * Check which agent capabilities are currently available.
 * Results are cached for 30s to avoid repeated expensive checks.
 */
export async function getAgentCapabilities(): Promise<AgentCapabilities> {
  const now = Date.now();
  if (cachedCapabilities && now - cacheTime < CACHE_TTL_MS) {
    return cachedCapabilities;
  }

  const capabilities: AgentCapabilities = {
    shell: false,
    browser: false,
    queue: false,
  };

  // Check queue (Redis/BullMQ)
  try {
    const { isQueueActive } = await import('../task-queue.js');
    capabilities.queue = isQueueActive();
  } catch {
    capabilities.queue = false;
  }

  cachedCapabilities = capabilities;
  cacheTime = now;

  log.agents.info({ capabilities }, 'Agent capabilities checked');

  return capabilities;
}
