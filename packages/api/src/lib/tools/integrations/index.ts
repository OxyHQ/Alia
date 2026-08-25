/**
 * Integration Tools — Dynamic tools from user's connected OAuth integrations
 *
 * Queries the user's active Integration documents and creates AI SDK tool()
 * wrappers so the AI can interact with Google Calendar and Google Drive on the
 * user's behalf. GitHub, Notion, and Linear are now hosted MCP connectors and
 * are no longer served by the legacy Integrations system.
 */

import type { ToolSet } from 'ai';
import { getDb } from '../../../db/index.js';
import { listConnectedServices } from '../../../db/integrations/integrationRepository.js';
import { log } from '../../logger.js';
import { TTLCache } from '../../ttl-cache.js';
import { buildGoogleCalendarTools } from './google-calendar.js';
import { buildGoogleDriveTools } from './google-drive.js';

// Short-lived cache (same pattern as MCP tools). Tool closures capture only
// oxyUserId, so caching by user stays correct across callers — and the
// SELECTION is part of the key, so an agent granted one integration can never
// reuse the entry an unrestricted turn wrote.
const cache = new TTLCache<ToolSet>({ ttlMs: 30_000, maxSize: 2000 });

/**
 * Build integration tools for a user based on their connected OAuth services.
 */
export async function buildIntegrationTools(
  oxyUserId: string,
  /**
   * The integrations this turn may reach, or `undefined` for every connected
   * one.
   *
   * An integration is a row in the owner's connected services, so it is granted
   * by instance exactly as an MCP connector and an Oxy service are — an agent
   * arrives with the ids its owner named, and an EMPTY array means none.
   */
  serviceIds?: readonly string[],
): Promise<ToolSet> {
  if (serviceIds !== undefined && serviceIds.length === 0) return {};
  const cacheKey = JSON.stringify({
    oxyUserId,
    selection: serviceIds === undefined ? { kind: 'all' } : { ids: [...serviceIds].sort() },
  });
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const tools: ToolSet = {};

  try {
    const connected = new Set(await listConnectedServices(getDb(), oxyUserId));
    // Connected AND allowed. A granted id the person never connected produces
    // nothing, which is the same answer as not granting it.
    const usable =
      serviceIds === undefined ? connected : new Set(serviceIds.filter((id) => connected.has(id)));

    if (usable.has('google-calendar')) {
      Object.assign(tools, buildGoogleCalendarTools(oxyUserId));
    }
    if (usable.has('google-drive')) {
      Object.assign(tools, buildGoogleDriveTools(oxyUserId));
    }

    cache.set(cacheKey, tools);

    const toolCount = Object.keys(tools).length;
    if (toolCount > 0) {
      log.general.info({ userId: oxyUserId, toolCount }, 'Integration tools loaded');
    }

    return tools;
  } catch (err) {
    log.general.error({ err, userId: oxyUserId }, 'Failed to load integration tools');
    return {};
  }
}

// Re-export service builders for direct use
export { buildGoogleCalendarTools } from './google-calendar.js';
export { buildGoogleDriveTools } from './google-drive.js';
