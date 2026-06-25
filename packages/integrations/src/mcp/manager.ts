/**
 * MCP Server Manager
 *
 * Manages MCP server lifecycle: spawning child processes (stdio),
 * connecting to remote servers (HTTP), discovering tools,
 * and executing tool calls via JSON-RPC 2.0.
 */

import { spawn } from 'child_process';
import { errorMessage, errorCode } from '../shared/utils';
import type {
  McpServerSession,
  McpServerConfig,
  McpToolDefinition,
  McpResourceDefinition,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types';

const RPC_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BUFFER_BYTES = 1_024 * 1_024; // 1 MiB

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

  if (transport === 'stdio') {
    return startStdioServer(serverId, oxyUserId, config);
  }

  if (transport === 'streamable-http') {
    return startHttpServer(serverId, oxyUserId, config);
  }

  throw new Error(`Unsupported transport: ${transport}`);
}

export async function stopServer(serverId: string): Promise<void> {
  const session = sessions.get(serverId);
  if (!session) return;

  sessions.delete(serverId);

  // Clear kill timer if set from a previous stop
  if (session.killTimer) {
    clearTimeout(session.killTimer);
    session.killTimer = undefined;
  }

  // Reject all pending requests
  for (const [, pending] of session.pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Server stopped'));
  }
  session.pendingRequests.clear();

  // Kill child process with graceful fallback
  if (session.process && !session.process.killed) {
    session.process.kill('SIGTERM');
    session.killTimer = setTimeout(() => {
      if (session.process && !session.process.killed) {
        session.process.kill('SIGKILL');
      }
    }, 5_000);
  }

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

  const result = await sendRequest(session, 'tools/call', {
    name: toolName,
    arguments: args,
  });

  // MCP tool results: { content: [{ type: 'text', text: '...' }] }
  const content = (result as { content?: Array<{ type: string; text?: string }> } | null)?.content;
  if (content && Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
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
// Stdio Transport
// ---------------------------------------------------------------------------

async function startStdioServer(
  serverId: string,
  oxyUserId: string,
  config: McpServerConfig,
): Promise<{ tools: McpToolDefinition[]; resources: McpResourceDefinition[] }> {
  if (!config.command) {
    throw new Error('stdio transport requires a command');
  }

  const session: McpServerSession = {
    id: serverId,
    oxyUserId,
    transport: 'stdio',
    config,
    status: 'starting',
    tools: [],
    resources: [],
    startedAt: new Date(),
    pendingRequests: new Map(),
    nextRequestId: 1,
    stdoutBuffer: '',
  };

  sessions.set(serverId, session);

  try {
    const childEnv = { ...process.env, ...(config.env || {}) };

    const child = spawn(config.command, config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    session.process = child;

    child.stdout!.on('data', (data: Buffer) => {
      session.stdoutBuffer += data.toString();

      if (session.stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
        console.error(`[MCP:${serverId}] stdout buffer overflow, killing server`);
        session.status = 'error';
        session.statusMessage = 'stdout buffer overflow';
        child.kill('SIGTERM');
        return;
      }

      processStdoutBuffer(session);
    });

    child.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.warn(`[MCP:${serverId}] stderr: ${msg}`);
    });

    child.on('error', (err) => {
      console.error(`[MCP:${serverId}] Process error:`, errorMessage(err));
      session.status = 'error';
      session.statusMessage = errorMessage(err);
    });

    child.on('exit', (code, signal) => {
      console.log(`[MCP:${serverId}] Process exited (code=${code}, signal=${signal})`);
      if (session.status === 'running') {
        session.status = 'error';
        session.statusMessage = `Process exited unexpectedly (code=${code})`;
      }
      for (const [, pending] of session.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('MCP server process exited'));
      }
      session.pendingRequests.clear();
    });

    // MCP protocol handshake + tool discovery
    await performHandshake(session);
    const [tools, resources] = await Promise.all([
      discoverTools(session),
      discoverResources(session),
    ]);

    session.tools = tools;
    session.resources = resources;
    session.status = 'running';

    console.log(`[MCP:${serverId}] Started (${tools.length} tools, ${resources.length} resources)`);
    return { tools, resources };
  } catch (err: unknown) {
    cleanupFailedSession(serverId, session, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTTP Transport (streamable-http)
// ---------------------------------------------------------------------------

async function startHttpServer(
  serverId: string,
  oxyUserId: string,
  config: McpServerConfig,
): Promise<{ tools: McpToolDefinition[]; resources: McpResourceDefinition[] }> {
  if (!config.url) {
    throw new Error('streamable-http transport requires a url');
  }

  const session: McpServerSession = {
    id: serverId,
    oxyUserId,
    transport: 'streamable-http',
    config,
    status: 'starting',
    tools: [],
    resources: [],
    startedAt: new Date(),
    pendingRequests: new Map(),
    nextRequestId: 1,
    stdoutBuffer: '',
  };

  sessions.set(serverId, session);

  try {
    // Reuse the shared helpers — sendRequest dispatches to HTTP automatically
    await performHandshake(session);
    const [tools, resources] = await Promise.all([
      discoverTools(session),
      discoverResources(session),
    ]);

    session.tools = tools;
    session.resources = resources;
    session.status = 'running';

    console.log(`[MCP:${serverId}] Connected via streamable-http (${tools.length} tools)`);
    return { tools, resources };
  } catch (err: unknown) {
    cleanupFailedSession(serverId, session, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Session cleanup on failure
// ---------------------------------------------------------------------------

function cleanupFailedSession(serverId: string, session: McpServerSession, err: unknown): void {
  session.status = 'error';
  session.statusMessage = errorMessage(err);
  sessions.delete(serverId);

  if (session.process && !session.process.killed) {
    session.process.kill('SIGTERM');
  }

  for (const [, pending] of session.pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(err);
  }
  session.pendingRequests.clear();
}

// ---------------------------------------------------------------------------
// JSON-RPC Communication
// ---------------------------------------------------------------------------

function processStdoutBuffer(session: McpServerSession): void {
  const lines = session.stdoutBuffer.split('\n');
  session.stdoutBuffer = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const msg = JSON.parse(trimmed);
      handleJsonRpcMessage(session, msg);
    } catch {
      // Not JSON — server logging, ignore
    }
  }
}

function handleJsonRpcMessage(session: McpServerSession, msg: JsonRpcResponse): void {
  if (msg.id !== undefined && msg.id !== null) {
    const pending = session.pendingRequests.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    session.pendingRequests.delete(msg.id);

    if (msg.error) {
      const rpcError = new Error(msg.error.message || 'JSON-RPC error') as Error & { code?: number; data?: unknown };
      rpcError.code = msg.error.code;
      rpcError.data = msg.error.data;
      pending.reject(rpcError);
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  // Server notification — no action needed
}

function sendRequest(session: McpServerSession, method: string, params?: Record<string, unknown>): Promise<unknown> {
  if (session.transport === 'streamable-http') {
    return sendHttpRequest(session, method, params);
  }

  return new Promise((resolve, reject) => {
    const stdin = session.process?.stdin;
    if (!stdin?.writable) {
      return reject(new Error('MCP server stdin not writable'));
    }

    const id = session.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const timer = setTimeout(() => {
      session.pendingRequests.delete(id);
      reject(new Error(`JSON-RPC request timed out: ${method}`));
    }, RPC_TIMEOUT_MS);

    session.pendingRequests.set(id, { resolve, reject, timer });

    stdin.write(JSON.stringify(request) + '\n', (err) => {
      if (err) {
        clearTimeout(timer);
        session.pendingRequests.delete(id);
        reject(err);
      }
    });
  });
}

async function sendHttpRequest(session: McpServerSession, method: string, params?: Record<string, unknown>): Promise<unknown> {
  if (!session.config.url) {
    throw new Error('No URL configured for HTTP transport');
  }

  const id = session.nextRequestId++;
  const response = await fetch(session.config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(session.config.headers || {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const result = await response.json() as JsonRpcResponse;
  if (result.error) {
    const rpcError = new Error(result.error.message || 'JSON-RPC error') as Error & { code?: number; data?: unknown };
    rpcError.code = result.error.code;
    rpcError.data = result.error.data;
    throw rpcError;
  }
  return result.result;
}

function sendNotification(session: McpServerSession, method: string, params?: Record<string, unknown>): void {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method,
    ...(params !== undefined ? { params } : {}),
  });

  if (session.transport === 'streamable-http' && session.config.url) {
    // Fire-and-forget for HTTP notifications
    fetch(session.config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...(session.config.headers || {}) },
      body,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
    return;
  }

  const stdin = session.process?.stdin;
  if (!stdin?.writable) return;
  stdin.write(body + '\n');
}

// ---------------------------------------------------------------------------
// MCP Protocol
// ---------------------------------------------------------------------------

async function performHandshake(session: McpServerSession): Promise<void> {
  const result = await sendRequest(session, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'alia-integrations', version: '1.0.0' },
  });

  if (!result) {
    throw new Error('No response from MCP server initialize');
  }

  sendNotification(session, 'notifications/initialized');
}

async function discoverTools(session: McpServerSession): Promise<McpToolDefinition[]> {
  try {
    const result = await sendRequest(session, 'tools/list') as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    } | null;
    if (!result?.tools || !Array.isArray(result.tools)) return [];

    return result.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {},
    }));
  } catch {
    return [];
  }
}

async function discoverResources(session: McpServerSession): Promise<McpResourceDefinition[]> {
  try {
    const result = await sendRequest(session, 'resources/list') as {
      resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
    } | null;
    if (!result?.resources || !Array.isArray(result.resources)) return [];

    return result.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  } catch {
    return [];
  }
}
