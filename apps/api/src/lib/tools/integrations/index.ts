/**
 * Integration Tools — Dynamic tools from user's connected OAuth integrations
 *
 * Queries the user's active Integration documents and creates AI SDK tool()
 * wrappers so the AI can interact with GitHub, Notion, Google Calendar,
 * Linear, and Google Drive on the user's behalf.
 */

import type { ToolSet } from 'ai';
import mongoose from 'mongoose';
import { Integration } from '../../../models/integration.js';
import { log } from '../../logger.js';
import { buildGitHubTools } from './github.js';
import { buildNotionTools } from './notion.js';
import { buildGoogleCalendarTools } from './google-calendar.js';
import { buildLinearTools } from './linear.js';
import { buildGoogleDriveTools } from './google-drive.js';

// Short-lived cache (same pattern as MCP tools)
const cache = new Map<string, { tools: ToolSet; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

/**
 * Build integration tools for a user based on their connected OAuth services.
 */
export async function buildIntegrationTools(oxyUserId: string): Promise<ToolSet> {
  if (!mongoose.Types.ObjectId.isValid(oxyUserId)) return {};

  const cached = cache.get(oxyUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;

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

    if (connectedServices.has('github')) {
      Object.assign(tools, buildGitHubTools(oxyUserId));
    }
    if (connectedServices.has('notion')) {
      Object.assign(tools, buildNotionTools(oxyUserId));
    }
    if (connectedServices.has('google-calendar')) {
      Object.assign(tools, buildGoogleCalendarTools(oxyUserId));
    }
    if (connectedServices.has('linear')) {
      Object.assign(tools, buildLinearTools(oxyUserId));
    }
    if (connectedServices.has('google-drive')) {
      Object.assign(tools, buildGoogleDriveTools(oxyUserId));
    }

    cache.set(oxyUserId, { tools, expiresAt: Date.now() + CACHE_TTL_MS });

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
export { buildGitHubTools } from './github.js';
export { buildNotionTools } from './notion.js';
export { buildGoogleCalendarTools } from './google-calendar.js';
export { buildLinearTools } from './linear.js';
export { buildGoogleDriveTools } from './google-drive.js';
