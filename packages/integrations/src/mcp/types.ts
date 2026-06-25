/**
 * MCP Server Manager Types
 *
 * Types for managing MCP server processes and connections.
 * Supports stdio (child process) and HTTP (remote) transports.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpServerSession {
  id: string;
  oxyUserId: string;
  transport: 'stdio' | 'streamable-http';
  config: McpServerConfig;
  status: 'starting' | 'running' | 'stopped' | 'error';
  statusMessage?: string;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  startedAt: Date;
  process?: import('child_process').ChildProcess;
  killTimer?: NodeJS.Timeout;
  pendingRequests: Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: NodeJS.Timeout;
  }>;
  nextRequestId: number;
  stdoutBuffer: string;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
