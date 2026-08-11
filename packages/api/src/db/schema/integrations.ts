/**
 * Third-party connections: OAuth integrations, connected messaging accounts, MCP
 * servers, and the two short-lived OAuth state stores.
 *
 * ## This file holds every encrypted column in the schema
 *
 * `integrations.oauth_access_token` / `oauth_refresh_token` and the same pair on
 * `connected_accounts` are `encryptedText` — see `columns.ts` for what that is
 * and, more importantly, for the two ways a backfill can get it wrong. In Mongo
 * these were `set: encrypt, get: decrypt` field-level setters, so encryption held
 * by construction; `encryptedText` is what keeps that structural rather than
 * remembered.
 *
 * Two columns here are NOT encrypted and hold secrets anyway:
 * `mcp_servers.config_headers` and `config_env` are arbitrary maps a user
 * supplies to reach their own MCP server, and an API key in an `Authorization`
 * header is the ordinary case. They are `jsonb` because their shape belongs to
 * whichever server the user is configuring, which is exactly the reason a
 * typed-column allow-list is not available here — so the projection rule is the
 * defence: never select them into anything a user did not ask for, never log
 * them.
 */

import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf, encryptedText } from './columns';

export const CONNECTED_ACCOUNT_STATUSES = [
  'connecting',
  'connected',
  'disconnected',
  'error',
  'expired',
] as const;
export type ConnectedAccountStatus = (typeof CONNECTED_ACCOUNT_STATUSES)[number];

export const INTEGRATION_STATUSES = ['active', 'expired', 'revoked', 'error'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const MCP_SERVER_SOURCES = ['registry', 'custom'] as const;
export type McpServerSource = (typeof MCP_SERVER_SOURCES)[number];

export const MCP_SERVER_TRANSPORTS = ['stdio', 'sse', 'streamable-http'] as const;
export type McpServerTransport = (typeof MCP_SERVER_TRANSPORTS)[number];

export const MCP_SERVER_RUNTIMES = ['server', 'local'] as const;
export type McpServerRuntime = (typeof MCP_SERVER_RUNTIMES)[number];

export const MCP_SERVER_STATUSES = ['installed', 'running', 'stopped', 'error'] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

/**
 * An element of `mcp_servers.tools` / `.resources`.
 *
 * Declared here rather than on the Mongoose model because the column owns its
 * element shape, and because these outlive the model: `tools[].inputSchema` is
 * JSON Schema the MCP server itself supplies, a format this service does not own
 * and cannot narrow further than `Record<string, unknown>`.
 */
export interface McpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerResource {
  uri: string;
  name: string;
  description?: string;
}

/**
 * One user's OAuth connection to a third-party service.
 *
 * The `oauthTokens` sub-document was `required`, and `accessToken`, `scope` and
 * `tokenType` were required within it, so all three are `notNull` here. That is
 * the opposite of `connected_accounts`, where the whole group is optional — the
 * two are not the same shape and must not be unified.
 *
 * `service` has no CHECK: its values come from `lib/integration-registry.ts`,
 * which is a runtime list this schema does not own and which grows without a
 * migration. `status` is Alia's own vocabulary and does carry one.
 */
export const integrations = pgTable(
  'integrations',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    service: text().notNull(),
    displayName: text().notNull(),
    /** Encrypted at rest. Never select into a response. */
    oauthAccessToken: encryptedText().notNull(),
    /** Encrypted at rest. Never select into a response. */
    oauthRefreshToken: encryptedText(),
    oauthExpiresAt: timestamptz(),
    oauthScope: text().notNull(),
    oauthTokenType: text().notNull(),
    accountId: text(),
    accountName: text(),
    avatarUrl: text(),
    status: text({ enum: INTEGRATION_STATUSES as unknown as [string, ...string[]] })
      .$type<IntegrationStatus>()
      .notNull()
      .default('active'),
    enabled: boolean().notNull().default(true),
    /** Shape belongs to whichever service was connected. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    connectedAt: timestamptz().notNull(),
    lastUsedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('integrations_oxy_user_id_idx').on(t.oxyUserId),
    index('integrations_oxy_user_service_idx').on(t.oxyUserId, t.service),
    checkOneOf('integrations_status_check', t.status, INTEGRATION_STATUSES),
  ],
);

/**
 * A messaging account (WhatsApp, Telegram, …) connected to Alia.
 *
 * Unlike `integrations`, the OAuth group is OPTIONAL as a whole — most connected
 * accounts are session-based and carry none. `connected_accounts_oauth_pair_check`
 * is what stops a half-written group: a token without its scope, or a scope
 * without its token, is not a state any writer means to produce, and Mongo could
 * not express it because the sub-document's `required` applied only when the
 * sub-document itself was present.
 *
 * `allowed_skill_ids` is a `text[]` of `skills` rows with no foreign key —
 * Postgres cannot constrain array MEMBERS, and that table is batch 8 regardless.
 */
export const connectedAccounts = pgTable(
  'connected_accounts',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    platform: text().notNull(),
    accountId: text().notNull(),
    displayName: text(),
    phoneNumber: text(),
    email: text(),
    avatarUrl: text(),
    status: text({ enum: CONNECTED_ACCOUNT_STATUSES as unknown as [string, ...string[]] })
      .$type<ConnectedAccountStatus>()
      .notNull()
      .default('connecting'),
    statusMessage: text(),
    sessionId: text(),
    capabilities: text().array().notNull().default(sql`'{}'::text[]`),
    autoReply: boolean().notNull().default(false),
    /** An `agents` row. No foreign key — that table is batch 9. */
    autoReplyAgentId: text(),
    customContext: text(),
    allowedTools: text().array(),
    blockedTools: text().array(),
    allowedSkillIds: text().array(),
    /** Encrypted at rest. Never select into a response. */
    oauthAccessToken: encryptedText(),
    /** Encrypted at rest. Never select into a response. */
    oauthRefreshToken: encryptedText(),
    oauthExpiresAt: timestamptz(),
    oauthScope: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    lastActiveAt: timestamptz(),
    connectedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('connected_accounts_oxy_user_platform_idx').on(t.oxyUserId, t.platform),
    index('connected_accounts_oxy_user_id_idx').on(t.oxyUserId),
    index('connected_accounts_session_id_idx').on(t.sessionId),
    checkOneOf('connected_accounts_status_check', t.status, CONNECTED_ACCOUNT_STATUSES),
    // The OAuth group is present as a whole or absent as a whole. A refresh
    // token or an expiry without an access token is not a state a writer means.
    check(
      'connected_accounts_oauth_pair_check',
      sql`(${t.oauthAccessToken} is null and ${t.oauthScope} is null
            and ${t.oauthRefreshToken} is null and ${t.oauthExpiresAt} is null)
        or (${t.oauthAccessToken} is not null and ${t.oauthScope} is not null)`,
    ),
  ],
);

/**
 * An MCP server a user has installed.
 *
 * `tools` and `resources` are `jsonb`: ordered capability listings read whole
 * when the server is dispatched to, with no cross-table reference and no
 * per-element toggle — the `fallback_events.attempts` shape rather than the
 * `alia_model_provider_mappings` one. `tools[].inputSchema` is a JSON Schema
 * supplied by the server itself, which is a format this service does not own.
 *
 * `config_headers` and `config_env` hold user-supplied secrets; see the file
 * comment. The rest of `config` has a fixed known shape and becomes columns.
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    name: text().notNull(),
    displayName: text().notNull(),
    description: text(),
    icon: text(),
    source: text({ enum: MCP_SERVER_SOURCES as unknown as [string, ...string[]] })
      .$type<McpServerSource>()
      .notNull()
      .default('registry'),
    registryId: text(),
    transport: text({ enum: MCP_SERVER_TRANSPORTS as unknown as [string, ...string[]] })
      .$type<McpServerTransport>()
      .notNull(),
    runtime: text({ enum: MCP_SERVER_RUNTIMES as unknown as [string, ...string[]] })
      .$type<McpServerRuntime>()
      .notNull()
      .default('server'),
    configCommand: text(),
    configArgs: text().array(),
    configUrl: text(),
    /** User-supplied and routinely secret-bearing. Never log; never select by default. */
    configHeaders: jsonb().$type<Record<string, string>>(),
    /** User-supplied and routinely secret-bearing. Never log; never select by default. */
    configEnv: jsonb().$type<Record<string, string>>(),
    configRequiresOauth: boolean(),
    status: text({ enum: MCP_SERVER_STATUSES as unknown as [string, ...string[]] })
      .$type<McpServerStatus>()
      .notNull()
      .default('installed'),
    statusMessage: text(),
    tools: jsonb().$type<McpServerTool[]>().notNull().default([]),
    resources: jsonb().$type<McpServerResource[]>(),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('mcp_servers_oxy_user_id_idx').on(t.oxyUserId),
    /**
     * `McpServerSchema.index({ oxyUserId: 1, name: 1 }, { unique: true })`, and
     * the ONE index of this slice's twenty-six that the schema batch did not
     * port. It is not decoration.
     *
     * `POST /mcp/install` is idempotent for registry connectors — the Connect
     * flow calls it to ensure the connector exists before starting OAuth, and a
     * second call must return the EXISTING row with 200 rather than 409. The
     * route decides which by catching the duplicate-key error this index raises.
     * Without it the insert simply succeeds, so every Connect attempt installs
     * another copy of the same connector under the same user, silently: no
     * error, no 409, a growing list of duplicates and an OAuth flow attached to
     * whichever row was found last. Loud in Mongo, quiet here.
     */
    uniqueIndex('mcp_servers_oxy_user_name_key').on(t.oxyUserId, t.name),
    checkOneOf('mcp_servers_source_check', t.source, MCP_SERVER_SOURCES),
    checkOneOf('mcp_servers_transport_check', t.transport, MCP_SERVER_TRANSPORTS),
    checkOneOf('mcp_servers_runtime_check', t.runtime, MCP_SERVER_RUNTIMES),
    checkOneOf('mcp_servers_status_check', t.status, MCP_SERVER_STATUSES),
  ],
);

/**
 * How long an abandoned MCP OAuth handshake survives.
 *
 * It lived on the Mongoose model, and its two consumers — `db/expiryTargets.ts`
 * for the sweep's retention and `routes/mcp.ts` for the liveness check the
 * callback makes — imported it from there. That is a co-located CONSTANT in a
 * module the port deletes, so it moves to the column it describes rather than
 * being carried along with a model that is going away. One number, two readers,
 * and the sweep and the check cannot now disagree.
 */
export const MCP_OAUTH_STATE_TTL_SECONDS = 10 * 60;

/**
 * The MCP connector's single-use OAuth `state`.
 *
 * TTL: 10 minutes from `created_at` (`MCP_OAUTH_STATE_TTL_SECONDS`). The row is
 * consumed by an atomic delete, so the sweep only ever reaps ABANDONED flows —
 * which is why a retention measured from creation is right here and a deadline
 * column would be redundant.
 *
 * `state` is the credential: whoever presents it recovers the originating user
 * and server. Unique, never logged.
 */
export const mcpOauthStates = pgTable(
  'mcp_oauth_states',
  {
    id: generatedId(),
    state: text().notNull(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    serverId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mcp_oauth_states_state_key').on(t.state),
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('mcp_oauth_states_created_at_idx').on(t.createdAt),
  ],
);

/**
 * The integrations OAuth `state`, and the one model in this batch declared
 * INLINE in a route file (`routes/integrations-oauth.ts`) rather than under a
 * model directory.
 *
 * That placement is why it is worth naming here: a model census scoped to
 * `src/models/` and `src/internal/providers/models/` does not see it, and it
 * carries a TTL — so it would have been ported without a sweep entry and the
 * table would have grown forever. The coverage gate reads registered Mongoose
 * models rather than source paths, which is what makes it immune to this.
 *
 * TTL: `expireAfterSeconds: 0` on `expires_at` — the column IS the deadline, so
 * retention is ZERO. Contrast `organization_invites`, whose deadline column
 * carries a 30-day retention; the two look alike and are not.
 *
 * The PRIMARY KEY is the state token itself (Mongo declared `_id: String` and
 * wrote the random token into it), so `generatedId()` would be wrong here for
 * the same reason it is wrong on `user_credits`: a minted default would produce
 * a row the callback could never find.
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    /** The random state token, and the credential. No default. */
    id: text().primaryKey(),
    service: text().notNull(),
    /** An Oxy account. No foreign key. */
    userId: text().notNull(),
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('oauth_states_expires_at_idx').on(t.expiresAt),
  ],
);
