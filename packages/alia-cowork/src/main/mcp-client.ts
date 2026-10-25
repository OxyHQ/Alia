/**
 * MCP Local Client — Cowork
 *
 * Manages local MCP server processes on the user's machine and bridges
 * their tools to the Alia API via WebSocket. This enables local MCP
 * servers (filesystem, git, etc.) to be available in the chat pipeline.
 */

import { spawn, type ChildProcess } from 'child_process';
import Store from 'electron-store';
import { errorMessage } from './errors';
import { createLogger } from './logger';
import { currentAccessToken, linkedAliaClient, onSessionContextChange } from './auth';

const store = new Store();
const logger = createLogger('MCP');

const JSON_RPC_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;
const MAX_STDOUT_BUFFER = 1024 * 1024; // 1 MiB

interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface LocalServer {
  config: McpServerConfig;
  process: ChildProcess;
  tools: McpTool[];
  nextId: number;
  pending: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >;
  buffer: string;
}

/** Server entry returned by `GET /mcp/installed`. */
interface InstalledServerEntry {
  _id: string;
  name: string;
  runtime?: string;
  enabled?: boolean;
  config?: { command?: string; args?: string[]; env?: Record<string, string> };
}

/** A single JSON-RPC `tools/list` tool descriptor. */
interface RpcToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A `tools/call` content block. */
interface RpcContentBlock {
  type: string;
  text?: string;
}

/** Inbound message from the relay WebSocket. */
interface RelayMessage {
  type: string;
  callId?: string;
  serverId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  error?: string;
}

export class McpLocalClient {
  private ws: WebSocket | null = null;
  private servers = new Map<string, LocalServer>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Whether `start` has gone as far as connecting the relay: a second `start` is then a no-op. */
  private running = false;
  /** Consecutive failed connections: the exponent of the reconnect delay. */
  private reconnectAttempts = 0;
  private transport?: ReturnType<typeof linkedAliaClient>;
  private readonly controller = new AbortController();
  private disposeContext?: () => void;

  /**
   * Start the MCP client: fetch local servers, spawn them, and connect to relay.
   */
  async start(): Promise<void> {
    if (this.running || this.stopped) return;
    if (!currentAccessToken()) return;
    this.running = true;
    const baseUrl = (store.get('apiBaseUrl') as string) || 'https://api.alia.onl';
    this.transport = linkedAliaClient(baseUrl);
    this.disposeContext = onSessionContextChange(() => void this.shutdown());
    try {
      const configs = await this.fetchLocalServers(baseUrl);
      if (this.stopped) return;
      if (!configs.length) return;

      for (const config of configs) {
        if (this.servers.has(config.id)) continue;
        await this.spawnServer(config);
        if (this.stopped) return;
      }

      void this.connectRelay();
    } catch (err) {
      logger.error('Failed to start:', err);
    }
  }

  private async fetchLocalServers(baseUrl: string): Promise<McpServerConfig[]> {
    if (!this.transport) return [];
    const response = await this.transport.fetch(`${baseUrl}/mcp/installed`, {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) return [];

    const data = (await response.json()) as { servers?: InstalledServerEntry[] };
    return (data.servers || [])
      .filter(
        (s): s is InstalledServerEntry & { config: { command: string } } =>
          s.runtime === 'local' && Boolean(s.enabled) && Boolean(s.config?.command),
      )
      .map((s) => ({
        id: s._id,
        name: s.name,
        command: s.config.command,
        args: s.config.args || [],
        env: s.config.env,
      }));
  }

  private async spawnServer(config: McpServerConfig): Promise<void> {
    try {
      const proc = spawn(config.command, config.args, {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const server: LocalServer = {
        config,
        process: proc,
        tools: [],
        nextId: 0,
        pending: new Map(),
        buffer: '',
      };

      proc.stdout!.on('data', (chunk: Buffer) => {
        server.buffer += chunk.toString();
        if (server.buffer.length > MAX_STDOUT_BUFFER) {
          server.buffer = server.buffer.slice(-MAX_STDOUT_BUFFER);
        }
        this.processStdout(server);
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        logger.warn(`${config.name}: ${chunk.toString().trim()}`);
      });

      const dropServer = (): void => {
        if (this.servers.get(config.id) !== server) return;
        this.servers.delete(config.id);
        for (const pending of server.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`${config.name} stopped`));
        }
        server.pending.clear();
        this.sendMessage({ type: 'unregister-tools', serverId: config.id });
      };

      proc.on('exit', (code) => {
        logger.info(`${config.name} exited (code ${code})`);
        dropServer();
      });

      // A command that does not exist is an 'error' event, not an exit: unhandled it throws in the
      // main process. A closed pipe is an 'error' on stdin the same way.
      proc.on('error', (err) => {
        logger.error(`${config.name} process error:`, err);
        dropServer();
      });
      proc.stdin!.on('error', (err) => logger.warn(`${config.name} stdin error:`, err));
      proc.stdout!.on('error', (err) => logger.warn(`${config.name} stdout error:`, err));
      proc.stderr!.on('error', (err) => logger.warn(`${config.name} stderr error:`, err));

      this.servers.set(config.id, server);

      await this.initializeServer(server);
      server.tools = await this.discoverTools(server);
      logger.info(`${config.name} started with ${server.tools.length} tools`);
    } catch (err) {
      logger.error(`${config.name} failed to spawn:`, err);
      // Half-started: initialisation failed or timed out. Do not leave a process nobody can use.
      const half = this.servers.get(config.id);
      if (half) {
        this.servers.delete(config.id);
        half.process.kill('SIGTERM');
      }
    }
  }

  private sendRpc(
    server: LocalServer,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++server.nextId;
      const timer = setTimeout(() => {
        server.pending.delete(id);
        reject(new Error(`JSON-RPC timeout: ${method}`));
      }, JSON_RPC_TIMEOUT_MS);

      server.pending.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n';
      server.process.stdin!.write(msg, (err) => {
        if (!err) return;
        clearTimeout(timer);
        server.pending.delete(id);
        reject(err);
      });
    });
  }

  private processStdout(server: LocalServer): void {
    const lines = server.buffer.split('\n');
    server.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;

        const pending = server.pending.get(msg.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        server.pending.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'JSON-RPC error'));
        } else {
          pending.resolve(msg.result);
        }
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  private async initializeServer(server: LocalServer): Promise<void> {
    await this.sendRpc(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'alia-cowork', version: '1.0.0' },
    });
    server.process.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }

  private async discoverTools(server: LocalServer): Promise<McpTool[]> {
    const result = await this.sendRpc(server, 'tools/list');
    const tools = (result as { tools?: RpcToolDescriptor[] } | null)?.tools || [];
    return tools.map((t) => ({
      name: t.name,
      description: t.description || t.name,
      inputSchema: t.inputSchema || {},
    }));
  }

  /** Delay before the next reconnect: doubles per failed attempt, capped, with jitter. */
  private reconnectDelay(): number {
    const base = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  private async connectRelay(): Promise<void> {
    if (this.stopped || !this.transport) return;
    const baseUrl = (store.get('apiBaseUrl') as string) || 'https://api.alia.onl';
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws/mcp';

    try {
      const token = await this.transport.getAccessToken(wsUrl, { signal: this.controller.signal });
      if (this.stopped || !token) return;
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (this.stopped || this.ws !== socket) return;
        logger.info('MCP relay connected');
        this.sendMessage({ type: 'auth', token });
      };

      socket.onmessage = (event) => {
        if (this.stopped || this.ws !== socket) return;
        try {
          const msg = JSON.parse(event.data as string) as RelayMessage;
          this.handleRelayMessage(msg);
        } catch (err) {
          logger.error('Failed to handle relay message:', err);
        }
      };

      socket.onclose = () => {
        if (this.stopped || this.ws !== socket) return;
        const delay = this.reconnectDelay();
        logger.info(`MCP relay disconnected, reconnecting in ${delay} ms`);
        this.reconnectTimer = setTimeout(() => this.connectRelay(), delay);
      };

      socket.onerror = () => {
        // onclose will handle reconnection
      };
    } catch (err) {
      if (this.stopped) return;
      logger.error('Failed to connect relay:', err);
      this.reconnectTimer = setTimeout(() => this.connectRelay(), this.reconnectDelay());
    }
  }

  private handleRelayMessage(msg: RelayMessage): void {
    switch (msg.type) {
      case 'auth-ok':
        this.reconnectAttempts = 0;
        for (const server of this.servers.values()) {
          this.sendMessage({
            type: 'register-tools',
            serverId: server.config.id,
            serverName: server.config.name,
            tools: server.tools,
          });
        }
        break;

      case 'auth-error':
        logger.error('Auth failed:', msg.error);
        this.ws?.close();
        break;

      case 'tool-call':
        this.handleToolCall(msg).catch((err) => logger.error('Tool call handling failed:', err));
        break;
    }
  }

  private async handleToolCall(msg: RelayMessage): Promise<void> {
    const socket = this.ws;
    const { callId, serverId, toolName, args } = msg;
    const server = serverId ? this.servers.get(serverId) : undefined;

    if (!server) {
      this.sendMessage({ type: 'tool-error', callId, error: 'Server not found' });
      return;
    }

    try {
      const result = await this.sendRpc(server, 'tools/call', {
        name: toolName,
        arguments: args || {},
      });

      // Extract text content from MCP response
      const content = (result as { content?: RpcContentBlock[] } | null)?.content;
      let text = '';
      if (Array.isArray(content)) {
        text = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n');
      } else {
        text = JSON.stringify(result);
      }

      if (this.ws === socket && !this.stopped)
        this.sendMessage({ type: 'tool-result', callId, result: text });
    } catch (err: unknown) {
      if (this.ws === socket && !this.stopped)
        this.sendMessage({ type: 'tool-error', callId, error: errorMessage(err) });
    }
  }

  private sendMessage(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    this.disposeContext?.();
    this.disposeContext = undefined;
    this.transport?.dispose();
    this.transport = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    for (const server of this.servers.values()) {
      for (const pending of server.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Shutting down'));
      }
      server.process.kill('SIGTERM');
    }
    this.servers.clear();

    const socket = this.ws;
    this.ws = null;
    socket?.close();
  }
}
