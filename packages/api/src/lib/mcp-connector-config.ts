/**
 * The config the integrations service receives for one installed connector.
 *
 * A connector installed from the registry is reached at the registry's address
 * and with the registry's OAuth settings, whatever its row says: a person may
 * edit a connector's config, and an edited URL must never receive a client
 * secret Alia holds for a vendor. A custom connector is sent as stored.
 */

import {
  toMcpServerConfig,
  type McpServerConfig,
  type McpServerRow,
} from '../db/integrations/mcpServerRepository.js';
import { MCP_REGISTRY, type McpRegistryEntry } from './mcp-registry.js';

export interface IntegrationsMcpConfig extends McpServerConfig {
  oauthClient?: { clientId: string; clientSecret?: string };
  oauthScope?: string;
  oauthRevocation?: { url: string; clientAuth: 'basic' | 'body' };
}

export function registryEntryOf(row: Pick<McpServerRow, 'source' | 'registryId'>) {
  if (row.source !== 'registry' || !row.registryId) return undefined;
  return MCP_REGISTRY.find((entry) => entry.id === row.registryId);
}

/**
 * The pre-registered client for an entry, read from the environment now. `null`
 * means the entry needs one and it is not configured; `undefined` means the
 * entry uses Dynamic Client Registration.
 */
export function registryOAuthClient(
  entry: McpRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
): { clientId: string; clientSecret?: string } | null | undefined {
  const client = entry.oauth?.client;
  if (!client) return undefined;
  const clientId = env[client.envClientId]?.trim();
  if (!clientId) return null;
  if (!client.envClientSecret) return { clientId };
  const clientSecret = env[client.envClientSecret]?.trim();
  if (!clientSecret) return null;
  return { clientId, clientSecret };
}

/** Whether a registry entry can be connected with this deployment's configuration. */
export function isRegistryEntryConfigured(
  entry: McpRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const gate = entry.oauth?.enabledBy;
  if (gate && env[gate]?.trim().toLowerCase() !== 'true') return false;
  return registryOAuthClient(entry, env) !== null;
}

export function integrationsConfigFor(
  row: McpServerRow,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationsMcpConfig {
  const stored = toMcpServerConfig(row);
  const entry = registryEntryOf(row);
  if (!entry?.url) return stored;
  const client = registryOAuthClient(entry, env);
  return {
    ...stored,
    url: entry.url,
    ...(client ? { oauthClient: client } : {}),
    ...(entry.oauth?.scope ? { oauthScope: entry.oauth.scope } : {}),
    ...(entry.oauth?.revocation ? { oauthRevocation: entry.oauth.revocation } : {}),
  };
}
