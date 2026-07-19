/**
 * Integration Tools — Dynamic tools from user's connected OAuth integrations
 *
 * Queries the user's active Integration documents and creates AI SDK tool()
 * wrappers so the AI can interact with Google Calendar and Google Drive on the
 * user's behalf. GitHub, Notion, and Linear are now hosted MCP connectors and
 * are no longer served by the legacy Integrations system.
 */

import type { ToolSet } from 'ai';
import mongoose from 'mongoose';
import { Integration } from '../../../models/integration.js';
import { log } from '../../logger.js';
import { TTLCache } from '../../ttl-cache.js';
import { buildGoogleCalendarTools } from './google-calendar.js';
import { buildGoogleDriveTools } from './google-drive.js';

// Short-lived per-user cache (same pattern as MCP tools). Tool closures capture
// only oxyUserId, so caching by user stays correct across callers.
const cache = new TTLCache<ToolSet>({ ttlMs: 30_000, maxSize: 2000 });

/**
 * Build integration tools for a user based on their connected OAuth services.
 */
export async function buildIntegrationTools(oxyUserId: string): Promise<ToolSet> {
  if (!mongoose.Types.ObjectId.isValid(oxyUserId)) return {};

  const cached = cache.get(oxyUserId);
  if (cached) return cached;

  const tools: ToolSet = {};

  try {
    const integrations = await Integration.find({
      oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
      enabled: true,
      status: 'active',
    })
      .select('service')
      .lean();

    const connectedServices = new Set(integrations.map(i => i.service));

    if (connectedServices.has('google-calendar')) {
      Object.assign(tools, buildGoogleCalendarTools(oxyUserId));
    }
    if (connectedServices.has('google-drive')) {
      Object.assign(tools, buildGoogleDriveTools(oxyUserId));
    }

    cache.set(oxyUserId, tools);

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
