/**
 * MCP Server Manager
 *
 * Manages MCP server lifecycle via the official `@modelcontextprotocol/sdk`
 * client: spawning child processes (stdio), connecting to remote servers
 * (SSE / streamable-http), discovering tools and resources, and executing
 * tool calls. The SDK client + transport own the process/connection lifecycle
 * and the JSON-RPC framing + initialize handshake.
 */

import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { errorMessage } from '../shared/utils';
import { createLogger } from '../shared/logger';
import { AliaOAuthProvider } from './oauth-provider';
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

  // For a previously-authorized OAuth connector, attach a provider so the SDK
  // reconnects with the stored tokens (and auto-refreshes). No interactive
  // state is needed for a plain reconnect — the callback→(user,server) mapping
  // only matters during the initial authorize.
  const authProvider = config.requiresOAuth
    ? new AliaOAuthProvider({
        oxyUserId,
        serverId,
        stateToken: randomUUID(),
        callbackUrl: defaultCallbackUrl(),
      })
    : undefined;

  // Build the transport first — this validates required config (command/url)
  // and constructs the transport WITHOUT spawning/connecting yet.
  const clientTransport = createTransport(transport, config, authProvider);
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

/**
 * Begin the interactive OAuth flow for a remote MCP connector.
 *
 * Runs the SDK's discovery + Dynamic Client Registration + PKCE, which triggers
 * the provider's `redirectToAuthorization`. Returns the authorization URL the
 * user must visit. No session is registered yet — that happens in `finishOAuth`
 * once the callback code is exchanged for tokens.
 */
export async function startOAuth(
  serverId: string,
  oxyUserId: string,
  transport: 'stdio' | 'sse' | 'streamable-http',
  config: McpServerConfig,
  stateToken: string,
  callbackUrl: string,
): Promise<{ authorizationUrl: string }> {
  if (!config.url) {
    throw new Error(`${transport} transport requires a url for OAuth`);
  }

  const provider = new AliaOAuthProvider({ oxyUserId, serverId, stateToken, callbackUrl });
  const result = await auth(provider, { serverUrl: config.url });

  if (result !== 'REDIRECT') {
    throw new Error(`Expected an OAuth redirect but the flow returned '${result}'`);
  }
  if (!provider.lastAuthorizationUrl) {
    throw new Error('OAuth flow did not produce an authorization URL');
  }

  logger.info(`[${serverId}] OAuth authorization started for user ${oxyUserId}`);
  return { authorizationUrl: provider.lastAuthorizationUrl };
}

/**
 * Complete the interactive OAuth flow: exchange the authorization code for
 * tokens (persisted encrypted by the provider), then connect the transport with
 * the provider attached, discover tools/resources, and register the session —
 * exactly as `startServer` does for the non-OAuth path.
 */
export async function finishOAuth(
  serverId: string,
  oxyUserId: string,
  transport: 'stdio' | 'sse' | 'streamable-http',
  config: McpServerConfig,
  code: string,
  callbackUrl: string,
): Promise<{ tools: McpToolDefinition[]; resources: McpResourceDefinition[] }> {
  if (!config.url) {
    throw new Error(`${transport} transport requires a url for OAuth`);
  }

  // A fresh provider reads the persisted DCR client info + PKCE verifier from
  // Mongo. The state token is irrelevant here (the callback→(user,server)
  // mapping already happened at the API), so a throwaway value is fine.
  const provider = new AliaOAuthProvider({
    oxyUserId,
    serverId,
    stateToken: randomUUID(),
    callbackUrl,
  });

  const result = await auth(provider, { serverUrl: config.url, authorizationCode: code });
  if (result !== 'AUTHORIZED') {
    throw new Error(`Expected OAuth authorization to complete but the flow returned '${result}'`);
  }

  if (sessions.has(serverId)) {
    await stopServer(serverId);
  }

  // Tokens are persisted; connect WITH the provider so the SDK attaches the
  // access token and auto-refreshes on expiry.
  const oauthConfig: McpServerConfig = { ...config, requiresOAuth: true };
  const clientTransport = createTransport(transport, oauthConfig, provider);
  const client = new Client({ name: 'alia-integrations', version: '1.0.0' }, { capabilities: {} });

  const session: McpServerSession = {
    id: serverId,
    oxyUserId,
    transport,
    config: oauthConfig,
    status: 'starting',
    tools: [],
    resources: [],
    startedAt: new Date(),
    client,
    clientTransport,
  };

  sessions.set(serverId, session);

  try {
    await client.connect(clientTransport);

    const tools = await discoverTools(client);
    const resources = await discoverResources(client);

    session.tools = tools;
    session.resources = resources;
    session.status = 'running';

    logger.info(`[${serverId}] OAuth connected via ${transport} (${tools.length} tools, ${resources.length} resources)`);
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
  authProvider?: OAuthClientProvider,
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

  // For OAuth connectors the SDK provider drives auth: it attaches the stored
  // access token, refreshes it on 401, and (on the interactive path) triggers
  // discovery + DCR + PKCE.
  const oauth = config.requiresOAuth && authProvider ? { authProvider } : {};

  if (transport === 'streamable-http') {
    if (!config.url) {
      throw new Error('streamable-http transport requires a url');
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      ...oauth,
      requestInit: { headers: config.headers ?? {} },
    });
  }

  if (transport === 'sse') {
    if (!config.url) {
      throw new Error('sse transport requires a url');
    }
    return new SSEClientTransport(new URL(config.url), {
      ...oauth,
      requestInit: { headers: config.headers ?? {} },
    });
  }

  throw new Error(`Unsupported transport: ${transport}`);
}

/**
 * The fixed public API callback URL the OAuth Authorization Server redirects to
 * (`GET /mcp/oauth/callback` on the API). Mirrors the same env + dev fallback
 * the API uses so the DCR `redirect_uris` match across processes.
 */
function defaultCallbackUrl(): string {
  return `${process.env.API_BASE_URL || 'http://localhost:3001'}/mcp/oauth/callback`;
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
