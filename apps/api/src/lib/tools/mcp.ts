/**
 * MCP Tools — Dynamic tool generation from user's MCP servers
 *
 * Queries user's enabled + running MCP servers and creates
 * Vercel AI SDK tool() wrappers that proxy calls to the integrations service.
 */

import { tool, type ToolSet } from 'ai';
import mongoose from 'mongoose';
import { McpServer } from '../../models/mcp-server.js';
import { log } from '../logger.js';
import { jsonSchemaToZod } from './mcp-schema.js';

const INTEGRATIONS_URL = process.env.INTEGRATIONS_URL;
const INTEGRATIONS_SECRET = process.env.INTEGRATIONS_SECRET;
const TOOL_CALL_TIMEOUT_MS = 60_000;

// Short-lived cache to avoid querying MongoDB on every chat message.
// MCP server config changes rarely; 30s staleness is acceptable.
const cache = new Map<string, { tools: ToolSet; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

/**
 * Build MCP tool set for a user.
 * Tool names are prefixed with `mcp_{serverName}_` to avoid collisions.
 */
export async function buildMcpTools(oxyUserId: string): Promise<ToolSet> {
  if (!INTEGRATIONS_URL || !INTEGRATIONS_SECRET) return {};
  if (!mongoose.Types.ObjectId.isValid(oxyUserId)) return {};

  const cached = cache.get(oxyUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;

  try {
    const servers = await McpServer.find({
      oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
      enabled: true,
      status: 'running',
      runtime: 'server',
    }).lean();

    if (!servers.length) {
      cache.set(oxyUserId, { tools: {}, expiresAt: Date.now() + CACHE_TTL_MS });
      return {};
    }

    const tools: ToolSet = {};

    for (const server of servers) {
      if (!server.tools?.length) continue;

      const serverId = server._id.toString();
      const prefix = `mcp_${sanitizeName(server.name)}`;

      for (const mcpTool of server.tools) {
        const toolName = `${prefix}__${sanitizeName(mcpTool.name)}`;

        if (tools[toolName]) {
          log.general.warn({ toolName, serverId }, 'MCP tool name collision, skipping');
          continue;
        }

        let inputSchema;
        try {
          inputSchema = jsonSchemaToZod(mcpTool.inputSchema as Record<string, any>);
        } catch {
          inputSchema = jsonSchemaToZod({});
        }

        tools[toolName] = tool({
          description: `[${server.displayName}] ${mcpTool.description || mcpTool.name}`,
          parameters: inputSchema,
          execute: async (args: Record<string, unknown>) => {
            return callMcpTool(serverId, mcpTool.name, args as Record<string, any>);
          },
        } as any);
      }
    }

    cache.set(oxyUserId, { tools, expiresAt: Date.now() + CACHE_TTL_MS });

    const toolCount = Object.keys(tools).length;
    if (toolCount > 0) {
      log.general.info({ userId: oxyUserId, toolCount }, 'MCP tools loaded');
    }

    return tools;
  } catch (err) {
    log.general.error({ err, userId: oxyUserId }, 'Failed to load MCP tools');
    return {};
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, any>,
): Promise<string> {
  const response = await fetch(
    `${INTEGRATIONS_URL}/mcp/servers/${serverId}/tools/${encodeURIComponent(toolName)}/call`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Secret': INTEGRATIONS_SECRET!,
      },
      body: JSON.stringify({ arguments: args }),
      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MCP tool call failed (${response.status}): ${body}`);
  }

  const data = await response.json() as any;
  if (data.error) {
    throw new Error(data.error);
  }

  return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
}
