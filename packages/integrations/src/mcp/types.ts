/**
 * MCP Server Manager Types
 *
 * Types for managing MCP server connections via the official
 * `@modelcontextprotocol/sdk` client.
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

/**
 * How this host reaches a connector: always over the network. A connector that
 * is a command runs on the person's own device (the API's `runtime: 'local'`,
 * through the MCP relay); this host is shared by every account and never starts
 * a process a person named.
 */
export const HOSTED_TRANSPORTS = ['sse', 'streamable-http'] as const;
export type HostedTransport = (typeof HOSTED_TRANSPORTS)[number];

export function isHostedTransport(value: unknown): value is HostedTransport {
  return (HOSTED_TRANSPORTS as readonly unknown[]).includes(value);
}

export interface McpServerSession {
  id: string;
  oxyUserId: string;
  transport: HostedTransport;
  config: McpServerConfig;
  status: 'starting' | 'running' | 'stopped' | 'error';
  statusMessage?: string;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  startedAt: Date;
  client: Client;
  clientTransport: Transport;
}

/**
 * A client the vendor registered for Alia ahead of time, for authorization servers
 * that offer no Dynamic Client Registration (or refuse unknown clients). The API
 * reads it from its own configuration on every call and it is never stored with
 * the connector, so rotating the secret needs no migration of user rows.
 */
export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
}

export interface McpServerConfig {
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** When true, remote (sse/streamable-http) transports authenticate via the MCP OAuth flow. */
  requiresOAuth?: boolean;
  /** Pre-registered OAuth client; absent means Dynamic Client Registration. */
  oauthClient?: McpOAuthClient;
  /**
   * The scopes to request, space separated. Absent means the SDK's choice (the
   * WWW-Authenticate challenge, then the resource's `scopes_supported`).
   */
  oauthScope?: string;
  /**
   * A revocation endpoint the vendor documents but does not advertise in its
   * metadata, and how it takes the client's credentials.
   */
  oauthRevocation?: { url: string; clientAuth: 'basic' | 'body' };
}
