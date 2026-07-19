/**
 * MCP Server Manager
 *
 * Manages MCP server lifecycle via the official `@modelcontextprotocol/sdk`
 * client: spawning child processes (stdio), connecting to remote servers
 * (SSE / streamable-http), discovering tools and resources, and executing
 * tool calls. The SDK client + transport own the process/connection lifecycle
 * and the JSON-RPC framing + initialize handshake.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { errorMessage } from '../shared/utils';
import { createLogger } from '../shared/logger';
import type {
  McpServerSession,
  McpServerConfig,
  McpToolDefinition,
  McpResourceDefinition,
} from './types';

const logger = createLogger('MCP');

/** Active server sessions keyed by server document ID */
const sessions = new Map<string, McpServerSession>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startServer(
  serverId: string,
  oxyUserId: string,
  transport: 'stdio' | 'sse' | 'streamable-http',
  config: McpServerConfig,
): Promise<{ tools: McpToolDefinition[]; resources: McpResourceDefinition[] }> {
  if (sessions.has(serverId)) {
    await stopServer(serverId);
  }

  // Build the transport first — this validates required config (command/url)
  // and constructs the transport WITHOUT spawning/connecting yet.
  const clientTransport = createTransport(transport, config);
  const client = new Client({ name: 'alia-integrations', version: '1.0.0' }, { capabilities: {} });

  const session: McpServerSession = {
    id: serverId,
    oxyUserId,
    transport,
    config,
    status: 'starting',
    tools: [],
    resources: [],
    startedAt: new Date(),
    client,
    clientTransport,
  };

  sessions.set(serverId, session);

  try {
    // connect() spawns the process (stdio) / opens the connection and performs
    // the MCP initialize handshake + notifications/initialized automatically.
    await client.connect(clientTransport);

    const tools = await discoverTools(client);
    const resources = await discoverResources(client);

    session.tools = tools;
    session.resources = resources;
    session.status = 'running';

    logger.info(`[${serverId}] Started via ${transport} (${tools.length} tools, ${resources.length} resources)`);
    return { tools, resources };
  } catch (err: unknown) {
    session.status = 'error';
    session.statusMessage = errorMessage(err);
    sessions.delete(serverId);
    await closeClient(client);
    throw err;
  }
}

export async function stopServer(serverId: string): Promise<void> {
  const session = sessions.get(serverId);
  if (!session) return;

  sessions.delete(serverId);
  await closeClient(session.client);
  session.status = 'stopped';
}

export async function callTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = sessions.get(serverId);
  if (!session) throw new Error('MCP server not running');
  if (session.status !== 'running') throw new Error(`MCP server is ${session.status}`);

  const result = await session.client.callTool({ name: toolName, arguments: args });

  // MCP tool results: { content: [{ type: 'text', text: '...' }] }
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('\n');
  }

  return result;
}

export function getSession(serverId: string): McpServerSession | undefined {
  return sessions.get(serverId);
}

export interface McpSessionSummary {
  id: string;
  oxyUserId: string;
  status: string;
  transport: string;
  toolCount: number;
}

export function listSessions(): McpSessionSummary[] {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    oxyUserId: s.oxyUserId,
    status: s.status,
    transport: s.transport,
    toolCount: s.tools.length,
  }));
}

export async function shutdownAll(): Promise<void> {
  const ids = Array.from(sessions.keys());
  await Promise.allSettled(ids.map((id) => stopServer(id)));
}

// ---------------------------------------------------------------------------
// Transport construction
// ---------------------------------------------------------------------------

function createTransport(
  transport: 'stdio' | 'sse' | 'streamable-http',
  config: McpServerConfig,
): Transport {
  if (transport === 'stdio') {
    if (!config.command) {
      throw new Error('stdio transport requires a command');
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // getDefaultEnvironment() is the SDK's safe inherited-env subset (PATH/HOME/…),
      // overlaid with any explicitly configured vars.
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
  }

  if (transport === 'streamable-http') {
    if (!config.url) {
      throw new Error('streamable-http transport requires a url');
    }
    // Phase 1: OAuthClientProvider will be injected here for per-user OAuth
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers ?? {} },
    });
  }

  if (transport === 'sse') {
    if (!config.url) {
      throw new Error('sse transport requires a url');
    }
    return new SSEClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers ?? {} },
    });
  }

  throw new Error(`Unsupported transport: ${transport}`);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discoverTools(client: Client): Promise<McpToolDefinition[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? {},
  }));
}

async function discoverResources(client: Client): Promise<McpResourceDefinition[]> {
  // listResources() throws if the server doesn't advertise the resources
  // capability — gate on the capability, and still tolerate a failing call.
  if (!client.getServerCapabilities()?.resources) {
    return [];
  }

  try {
    const { resources } = await client.listResources();
    return resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  } catch (err: unknown) {
    logger.warn(`Resource discovery failed: ${errorMessage(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function closeClient(client: Client): Promise<void> {
  try {
    await client.close();
  } catch (err: unknown) {
    logger.warn(`Error closing MCP client: ${errorMessage(err)}`);
  }
}
