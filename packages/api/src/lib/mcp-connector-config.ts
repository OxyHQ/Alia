/**
 * What an installed connector is, and the config the integrations service
 * receives for it.
 *
 * ## Where a connector runs follows from how it is reached
 *
 * Nothing a request sends changes it:
 *
 * - A connector that is a COMMAND (`stdio`) runs only on the person's own
 *   device: `runtime: 'local'`, started by Cowork or Codea and reached through
 *   the MCP relay. The integrations host is shared by every account and sits
 *   inside the VPC, so a command started there would run beside every other
 *   account's tokens and with the host's network reach. It never starts one,
 *   and `mcp_servers_command_runs_locally_check` holds the rule in Postgres.
 * - A REMOTE connector (`sse`, `streamable-http`) runs on the server and is
 *   reached at an https URL. Integrations judges that URL's address, and every
 *   address its server points at afterwards, on each connection
 *   (`packages/integrations/src/mcp/connector-fetch.ts`).
 *
 * ## A registry connector is the registry's
 *
 * A connector installed from the registry runs the registry's command or is
 * reached at the registry's address, with the registry's OAuth settings: a
 * person supplies only the values of the entry's `requiredEnv`, and an edited
 * URL never receives a client secret Alia holds for a vendor. A custom
 * connector is the person's, within the rules above.
 */

import { z } from 'zod';
import {
  toMcpServerConfig,
  type McpServerConfig,
  type McpServerRow,
} from '../db/integrations/mcpServerRepository.js';
import {
  MCP_SERVER_TRANSPORTS,
  type McpServerRuntime,
  type McpServerTransport,
} from '../db/schema/integrations.js';
import { MCP_REGISTRY, type McpRegistryEntry } from './mcp-registry.js';

export interface IntegrationsMcpConfig extends McpServerConfig {
  oauthClient?: { clientId: string; clientSecret?: string };
  oauthScope?: string;
  oauthRevocation?: { url: string; clientAuth: 'basic' | 'body' };
}

export function runtimeFor(transport: McpServerTransport): McpServerRuntime {
  return transport === 'stdio' ? 'local' : 'server';
}

const stringMap = z.record(z.string(), z.string());

/** What a person may set on a command connector, which runs on their own device. */
const commandConfig = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  env: stringMap.optional(),
});

/**
 * What a person may set on a remote connector. `requiresOAuth` is not among it:
 * the registry decides it for its entries, and completing OAuth records it.
 */
const remoteConfig = z.object({
  url: z
    .string()
    .refine(
      (url) => URL.canParse(url) && new URL(url).protocol === 'https:',
      'must be an https URL',
    ),
  headers: stringMap.optional(),
});

/** The config keys a person edits; `requiresOAuth` is not one (see `remoteConfig`). */
const EDITABLE_KEYS = ['command', 'args', 'url', 'headers', 'env'] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

/** Each editable key present, so a write sets all of them. */
type EditableConfig = Required<{ [K in EditableKey]: McpServerConfig[K] | undefined }>;

export interface ConnectorSpec {
  transport: McpServerTransport;
  runtime: McpServerRuntime;
  config: EditableConfig & Pick<McpServerConfig, 'requiresOAuth'>;
}

export type ConnectorSpecResult = { ok: true; spec: ConnectorSpec } | { ok: false; error: string };

function refusal(error: z.ZodError): ConnectorSpecResult {
  const issue = error.issues[0];
  const where = issue?.path.length ? `config.${issue.path.join('.')}` : 'config';
  return { ok: false, error: `${where}: ${issue?.message ?? 'invalid'}` };
}

/** A connector a person describes: the transport decides what config means and where it runs. */
export function parseConnector(transport: unknown, config: unknown): ConnectorSpecResult {
  const parsedTransport = z.enum(MCP_SERVER_TRANSPORTS).safeParse(transport);
  if (!parsedTransport.success) {
    return { ok: false, error: `transport must be one of: ${MCP_SERVER_TRANSPORTS.join(', ')}` };
  }
  const reached = parsedTransport.data;
  const parsed = (reached === 'stdio' ? commandConfig : remoteConfig).safeParse(config ?? {});
  if (!parsed.success) return refusal(parsed.error);
  return {
    ok: true,
    spec: {
      transport: reached,
      runtime: runtimeFor(reached),
      config: {
        command: undefined,
        args: undefined,
        url: undefined,
        headers: undefined,
        env: undefined,
        ...parsed.data,
      },
    },
  };
}

/** A registry connector: the entry's command or address, and the person's `requiredEnv` values. */
export function connectorFromRegistry(entry: McpRegistryEntry, env: unknown): ConnectorSpecResult {
  if (env !== undefined) {
    const parsedEnv = stringMap.safeParse(env);
    if (!parsedEnv.success) return { ok: false, error: 'env must map names to strings' };
    const foreign = Object.keys(parsedEnv.data).filter((key) => !entry.requiredEnv.includes(key));
    if (foreign.length > 0) {
      return { ok: false, error: `env may set only ${entry.requiredEnv.join(', ') || 'nothing'}` };
    }
  }
  const parsed = parseConnector(entry.transport, {
    command: entry.command,
    args: entry.args,
    url: entry.url,
    env,
  });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    spec: { ...parsed.spec, config: { ...parsed.spec.config, requiresOAuth: entry.requiresOAuth } },
  };
}

/**
 * An installed connector with a person's edit applied, validated as a whole.
 * A key sent as `null` clears it; a registry connector takes only `env`.
 */
export function patchedConnector(row: McpServerRow, patch: unknown): ConnectorSpecResult {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'config must be an object' };
  }
  const edit = patch as Record<string, unknown>;
  const stored = toMcpServerConfig(row);

  const entry = registryEntryOf(row);
  if (entry) {
    const fixed = Object.keys(edit).filter((key) => key !== 'env');
    if (fixed.length > 0) {
      return {
        ok: false,
        error: `a registry connector's ${fixed.join(', ')} come from the registry`,
      };
    }
    return connectorFromRegistry(
      entry,
      Object.hasOwn(edit, 'env') ? (edit.env ?? undefined) : stored.env,
    );
  }

  const merged = Object.fromEntries(
    EDITABLE_KEYS.map((key) => [
      key,
      Object.hasOwn(edit, key) ? (edit[key] ?? undefined) : stored[key],
    ]),
  );
  return parseConnector(row.transport, merged);
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
