/**
 * Agent Infrastructure Health Check
 *
 * Reports which agent capabilities are available based on
 * infrastructure status (Docker, Playwright, Redis).
 */

import { isSandboxAvailable } from '../sandbox/index.js';
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

  // Check sandbox (Docker)
  try {
    capabilities.shell = isSandboxAvailable();
  } catch {
    capabilities.shell = false;
  }

  // Check browser (Playwright/Stagehand)
  try {
    // Browser availability depends on sandbox since it runs in containers
    capabilities.browser = capabilities.shell;
  } catch {
    capabilities.browser = false;
  }

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
