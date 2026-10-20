/**
 * MCP Relay — WebSocket bridge for local MCP tool calls
 *
 * Manages WebSocket connections from Cowork/Codea clients that run
 * local MCP servers. Tools are registered by clients and made available
 * to the chat pipeline. Tool calls are proxied via WebSocket.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type http from 'http';
import { log } from './logger.js';
import { authenticateSocketToken } from './socket-session-auth.js';
import type { WebSocketRoute } from './websocket-upgrades.js';

interface LocalTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

interface RegisteredServer {
  serverId: string;
  serverName: string;
  tools: LocalTool[];
}

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  servers: Map<string, RegisteredServer>;
}

interface PendingCall {
  /** The account the call was sent to; only its socket may answer. */
  userId: string;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RelayMessage {
  type?: string;
  token?: string;
  serverId?: string;
  serverName?: string;
  tools?: LocalTool[];
  callId?: string;
  result?: unknown;
  error?: string;
}

const AUTH_TIMEOUT_MS = 5_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;

// Singleton state
let wss: WebSocketServer | null = null;
const clients = new Map<string, ConnectedClient>();
const pendingCalls = new Map<string, PendingCall>();

/** The MCP relay's path on the shared HTTP server. */
export const MCP_RELAY_PATH = '/ws/mcp';

/**
 * The MCP relay, as a route of the upgrade router (`lib/websocket-upgrades.ts`).
 *
 * `noServer`: with `{ server, path }` the ws library registers its own global
 * `server.on('upgrade')` that 400s every other path, stomping socket.io's
 * handshake on the same socket. The router hands this server its path only.
 */
export function mcpRelayRoute(
  observe?: (socket: WebSocket, headers: http.IncomingHttpHeaders) => void,
): WebSocketRoute {
  const relayServer = new WebSocketServer({ noServer: true });
  wss = relayServer;

  relayServer.on('connection', (ws, request) => {
    observe?.(ws, request.headers);
    let userId: string | null = null;

    const authTimer = setTimeout(() => {
      if (!userId) ws.close(4001, 'Auth timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', async (data) => {
      let msg: RelayMessage;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (parsed === null || typeof parsed !== 'object') return;
        msg = parsed as RelayMessage;
      } catch {
        return;
      }

      if (!userId) {
        if (msg.type !== 'auth') return;
        clearTimeout(authTimer);

        const id = await authenticateSocketToken(msg.token);
        if (!id) {
          ws.send(JSON.stringify({ type: 'auth-error', error: 'Invalid token' }));
          ws.close(4003, 'Forbidden');
          return;
        }

        userId = id;

        // Only one client per user — close previous
        const existing = clients.get(userId);
        if (existing && existing.ws.readyState === WebSocket.OPEN) {
          existing.ws.close(4000, 'Replaced by new connection');
        }

        clients.set(userId, { ws, userId, servers: new Map() });
        ws.send(JSON.stringify({ type: 'auth-ok' }));
        log.general.info({ userId }, 'MCP relay client connected');
        return;
      }

      handleClientMessage(userId, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      // A reconnect replaces this socket's entry; only drop our own.
      if (userId && clients.get(userId)?.ws === ws) {
        clients.delete(userId);
        log.general.info({ userId }, 'MCP relay client disconnected');
      }
    });

    ws.on('error', (err) => {
      log.general.warn({ err }, 'MCP relay WebSocket error');
    });
  });

  log.general.info(`MCP relay initialized at ${MCP_RELAY_PATH}`);
  return {
    path: MCP_RELAY_PATH,
    handleUpgrade: (request, socket, head) => {
      relayServer.handleUpgrade(request, socket, head, (ws) => {
        relayServer.emit('connection', ws, request);
      });
    },
  };
}

function handleClientMessage(userId: string, msg: RelayMessage): void {
  const client = clients.get(userId);
  if (!client) return;

  switch (msg.type) {
    case 'register-tools': {
      const { serverId, serverName, tools } = msg;
      if (!serverId || !Array.isArray(tools)) return;
      client.servers.set(serverId, {
        serverId,
        serverName: serverName || serverId,
        tools,
      });
      log.general.info({ userId, serverId, toolCount: tools.length }, 'Local MCP tools registered');
      break;
    }

    case 'unregister-tools': {
      if (!msg.serverId) return;
      client.servers.delete(msg.serverId);
      log.general.info({ userId, serverId: msg.serverId }, 'Local MCP tools unregistered');
      break;
    }

    case 'tool-result': {
      if (!msg.callId) return;
      const pending = pendingCalls.get(msg.callId);
      if (!pending || pending.userId !== userId) return;
      clearTimeout(pending.timer);
      pendingCalls.delete(msg.callId);
      pending.resolve(typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result));
      break;
    }

    case 'tool-error': {
      if (!msg.callId) return;
      const pending = pendingCalls.get(msg.callId);
      if (!pending || pending.userId !== userId) return;
      clearTimeout(pending.timer);
      pendingCalls.delete(msg.callId);
      pending.reject(new Error(msg.error || 'Local tool call failed'));
      break;
    }
  }
}

/**
 * Get all local MCP tools registered by a user's connected client.
 */
export function getLocalTools(
  userId: string,
): Array<{ serverId: string; serverName: string; tool: LocalTool }> {
  const client = clients.get(userId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) return [];

  const result: Array<{ serverId: string; serverName: string; tool: LocalTool }> = [];
  for (const server of client.servers.values()) {
    for (const tool of server.tools) {
      result.push({ serverId: server.serverId, serverName: server.serverName, tool });
    }
  }
  return result;
}

/**
 * Call a local MCP tool via the WebSocket relay.
 */
export function callLocalTool(
  userId: string,
  serverId: string,
  toolName: string,
  args: Record<string, any>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = clients.get(userId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Local MCP client not connected'));
    }

    const callId = randomUUID();
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      reject(new Error(`Local tool call timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s`));
    }, TOOL_CALL_TIMEOUT_MS);

    pendingCalls.set(callId, { userId, resolve, reject, timer });

    client.ws.send(JSON.stringify({ type: 'tool-call', callId, serverId, toolName, args }));
  });
}

/**
 * Graceful shutdown — close all connections and reject pending calls.
 */
export function shutdownMcpRelay(): void {
  for (const client of clients.values()) {
    client.ws.close(1001, 'Server shutting down');
  }
  clients.clear();

  for (const pending of pendingCalls.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Server shutting down'));
  }
  pendingCalls.clear();

  wss?.close();
}
