/**
 * MCP Tools — Dynamic tool generation from user's MCP servers
 *
 * Queries user's enabled + running MCP servers (server-side) and
 * connected local MCP clients (via WebSocket relay) to create
 * Vercel AI SDK tool() wrappers for the chat pipeline.
 */

import { tool, type ToolSet } from 'ai';
import { getDb } from '../../db/index.js';
import { listRunnableMcpServersForUser } from '../../db/integrations/mcpServerRepository.js';
import type { McpServerTool } from '../../db/schema/integrations.js';
import { log } from '../logger.js';
import { TTLCache } from '../ttl-cache.js';
import { jsonSchemaToZod } from './mcp-schema.js';
import { getLocalTools, callLocalTool } from '../mcp-relay.js';

const INTEGRATIONS_URL = process.env.INTEGRATIONS_URL;
const INTEGRATIONS_SECRET = process.env.INTEGRATIONS_SECRET;
const TOOL_CALL_TIMEOUT_MS = 60_000;

/** Response shape returned by the integrations service tool-call endpoint. */
interface McpToolCallResult {
  error?: string;
  result?: unknown;
}

// Short-lived per-user cache to avoid a database round trip on every chat
// message. MCP server config changes rarely; 30s staleness is acceptable. The
// selection is part of the key so a one-connector turn can never reuse the
// legacy all-connectors set.
const cache = new TTLCache<ToolSet>({ ttlMs: 30_000, maxSize: 2000 });

/**
 * Build MCP tool set for a user.
 * Includes both server-side MCP tools (via integrations service) and
 * local MCP tools (via WebSocket relay from Cowork/Codea).
 * Tool names are prefixed with `mcp_{serverName}_` to avoid collisions.
 */
export async function buildMcpTools(
  oxyUserId: string,
  /**
   * Which connectors this turn may reach.
   *
   * `undefined` means every runnable one, which is the historical behaviour for
   * a turn with no agent and no composer selection. An ARRAY names them
   * exactly, and an EMPTY array is a real answer meaning none — which is what an
   * agent granted no connector asks. The pipeline resolves the agent's grants
   * and the composer's per-turn pick into this one value.
   */
  selectedServerIds?: readonly string[],
): Promise<ToolSet> {
  if (selectedServerIds !== undefined && selectedServerIds.length === 0) return {};

  const cacheKey = JSON.stringify({
    oxyUserId,
    selection: selectedServerIds === undefined ? { kind: 'all' } : { ids: [...selectedServerIds].sort() },
  });
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const tools: ToolSet = {};

  try {
    // Server-side MCP tools (running in integrations service)
    if (INTEGRATIONS_URL && INTEGRATIONS_SECRET) {
      const servers = await listRunnableMcpServersForUser(
        getDb(),
        oxyUserId,
        selectedServerIds,
      );

      for (const server of servers) {
        if (!server.tools.length) continue;
        const serverId = server.id;
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

    /**
     * Local MCP tools (from connected Cowork/Codea client).
     *
     * A named selection is an allow-list of ROWS, and a local relay server is
     * not one: it lives as long as a device stays connected, has no row the
     * composer can offer and no id an agent's owner could grant. So it comes
     * only with the unselected path — which also means an AGENT never sees a
     * local connector, since an agent always arrives with a named selection.
     * That is the deliberate consequence of granting by instance.
     */
    const localEntries = selectedServerIds === undefined ? getLocalTools(oxyUserId) : [];
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

    cache.set(cacheKey, tools);

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
  mcpTool: McpServerTool,
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
    inputSchema,
    execute: async (args: Record<string, unknown>) => {
      return callServerTool(serverId, mcpTool.name, args as Record<string, any>);
    },
  });
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
    inputSchema,
    execute: async (args: Record<string, unknown>) => {
      return callLocalTool(userId, serverId, mcpTool.name, args as Record<string, any>);
    },
  });
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

  const data = (await response.json()) as McpToolCallResult;
  if (data.error) {
    throw new Error(data.error);
  }

  return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
}
