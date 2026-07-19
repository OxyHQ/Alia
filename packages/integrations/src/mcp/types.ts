/**
 * MCP Server Manager Types
 *
 * Types for managing MCP server connections via the official
 * `@modelcontextprotocol/sdk` client. Supports stdio (child process),
 * SSE, and streamable-http transports.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

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
  transport: 'stdio' | 'sse' | 'streamable-http';
  config: McpServerConfig;
  status: 'starting' | 'running' | 'stopped' | 'error';
  statusMessage?: string;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  startedAt: Date;
  client: Client;
  clientTransport: Transport;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** When true, remote (sse/streamable-http) transports authenticate via the MCP OAuth flow. */
  requiresOAuth?: boolean;
}
