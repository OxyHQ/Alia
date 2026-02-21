/**
 * MCP Tools — Dynamic tool generation from user's MCP servers
 *
 * Queries user's enabled + running MCP servers (server-side) and
 * connected local MCP clients (via WebSocket relay) to create
 * Vercel AI SDK tool() wrappers for the chat pipeline.
 */

import { tool, type ToolSet } from 'ai';
import mongoose from 'mongoose';
import { McpServer } from '../../models/mcp-server.js';
import { log } from '../logger.js';
import { jsonSchemaToZod } from './mcp-schema.js';
import { getLocalTools, callLocalTool } from '../mcp-relay.js';

const INTEGRATIONS_URL = process.env.INTEGRATIONS_URL;
const INTEGRATIONS_SECRET = process.env.INTEGRATIONS_SECRET;
const TOOL_CALL_TIMEOUT_MS = 60_000;

// Short-lived cache to avoid querying MongoDB on every chat message.
// MCP server config changes rarely; 30s staleness is acceptable.
const cache = new Map<string, { tools: ToolSet; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

/**
 * Build MCP tool set for a user.
 * Includes both server-side MCP tools (via integrations service) and
 * local MCP tools (via WebSocket relay from Cowork/Codea).
 * Tool names are prefixed with `mcp_{serverName}_` to avoid collisions.
 */
export async function buildMcpTools(oxyUserId: string): Promise<ToolSet> {
  if (!mongoose.Types.ObjectId.isValid(oxyUserId)) return {};

  const cached = cache.get(oxyUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;

  const tools: ToolSet = {};

  try {
    // Server-side MCP tools (running in integrations service)
    if (INTEGRATIONS_URL && INTEGRATIONS_SECRET) {
      const servers = await McpServer.find({
        oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
        enabled: true,
        status: 'running',
        runtime: 'server',
      }).lean();

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

          tools[toolName] = createServerTool(
            server.displayName,
            mcpTool,
            serverId,
          );
        }
      }
    }

    // Local MCP tools (from connected Cowork/Codea client)
    const localEntries = getLocalTools(oxyUserId);
    for (const { serverId, serverName, tool: mcpTool } of localEntries) {
      const toolName = `mcp_${sanitizeName(serverName)}__${sanitizeName(mcpTool.name)}`;
      if (tools[toolName]) {
        log.general.warn({ toolName, serverId }, 'Local MCP tool name collision, skipping');
        continue;
      }

      tools[toolName] = createLocalTool(
        serverName,
        mcpTool,
        oxyUserId,
        serverId,
      );
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

function createServerTool(
  displayName: string,
  mcpTool: { name: string; description: string; inputSchema: Record<string, any> },
  serverId: string,
) {
  let inputSchema;
  try {
    inputSchema = jsonSchemaToZod(mcpTool.inputSchema as Record<string, any>);
  } catch {
    inputSchema = jsonSchemaToZod({});
  }

  return tool({
    description: `[${displayName}] ${mcpTool.description || mcpTool.name}`,
    parameters: inputSchema,
    execute: async (args: Record<string, unknown>) => {
      return callServerTool(serverId, mcpTool.name, args as Record<string, any>);
    },
  } as any);
}

function createLocalTool(
  serverName: string,
  mcpTool: { name: string; description: string; inputSchema: Record<string, any> },
  userId: string,
  serverId: string,
) {
  let inputSchema;
  try {
    inputSchema = jsonSchemaToZod(mcpTool.inputSchema as Record<string, any>);
  } catch {
    inputSchema = jsonSchemaToZod({});
  }

  return tool({
    description: `[${serverName}] ${mcpTool.description || mcpTool.name}`,
    parameters: inputSchema,
    execute: async (args: Record<string, unknown>) => {
      return callLocalTool(userId, serverId, mcpTool.name, args as Record<string, any>);
    },
  } as any);
}

async function callServerTool(
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

  const data = (await response.json()) as any;
  if (data.error) {
    throw new Error(data.error);
  }

  return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
}
