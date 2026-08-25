/**
 * Installed MCP connectors, on Postgres.
 *
 * ## `config` is FLAT in the database and NESTED on both wires
 *
 * Mongo stored a `config` sub-document; the port flattened it to
 * `config_command`, `config_args`, `config_url`, `config_headers`, `config_env`
 * and `config_requires_oauth`. Two consumers still need the nested object and
 * neither can be changed from here:
 *
 *  - **`packages/integrations`** receives `{ config }` verbatim in the body of
 *    every `/mcp/servers/:id/{start,stop,oauth/start,oauth/finish}` call. It is
 *    a separate service with its own deploy.
 *  - **the shipped mobile build** reads `server.config.url`,
 *    `server.config.requiresOAuth` and friends off the API response, and reads
 *    the row's id as **`_id`**. A shipped build cannot be recalled.
 *
 * So `toMcpServerConfig` and `serializeMcpServer` are the two seams that keep
 * the stored shape and the wire shape apart, and they live here beside the
 * columns rather than in the route, because getting one of them wrong is a
 * silent `undefined` on the far side rather than an error. `_id` is served
 * ALONGSIDE `id`; what retires it is a mobile release that reads `id`, not a
 * decision taken here.
 *
 * `config_headers` and `config_env` hold user-supplied secrets — an API key in
 * an `Authorization` header is the ordinary case. They are projected only into
 * the two shapes above, which is what the source did, and they are never logged.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  mcpServers,
  type McpServerResource,
  type McpServerRuntime,
  type McpServerSource,
  type McpServerStatus,
  type McpServerTool,
  type McpServerTransport,
} from '../schema/integrations';

/** A connector row as stored. */
export type McpServerRow = typeof mcpServers.$inferSelect;

/** The nested `config` both wires expect. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  requiresOAuth?: boolean;
}

/**
 * Reassemble the nested `config` from the flat columns.
 *
 * A `null` column becomes an ABSENT key rather than `null`, because that is what
 * Mongoose produced for an unset sub-document field and what the integrations
 * service's `??`-style defaults are written against. `{ url: null }` and `{}`
 * are the same to a `if (config.url)` and different to a `Object.keys` count or
 * a JSON body a strict schema validates.
 */
export function toMcpServerConfig(row: McpServerRow): McpServerConfig {
  return {
    ...(row.configCommand === null ? {} : { command: row.configCommand }),
    ...(row.configArgs === null ? {} : { args: row.configArgs }),
    ...(row.configUrl === null ? {} : { url: row.configUrl }),
    ...(row.configHeaders === null ? {} : { headers: row.configHeaders }),
    ...(row.configEnv === null ? {} : { env: row.configEnv }),
    ...(row.configRequiresOauth === null ? {} : { requiresOAuth: row.configRequiresOauth }),
  };
}

/** The connector as the API has always served it. */
export interface SerializedMcpServer {
  _id: string;
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  source: McpServerSource;
  registryId: string | null;
  transport: McpServerTransport;
  runtime: McpServerRuntime;
  config: McpServerConfig;
  status: McpServerStatus;
  statusMessage: string | null;
  tools: McpServerTool[];
  resources: McpServerResource[] | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Row -> the response body.
 *
 * `oxy_user_id` is deliberately absent: it is the scope every query already
 * filters on, so echoing it back tells the caller only what they asked with.
 */
export function serializeMcpServer(row: McpServerRow): SerializedMcpServer {
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    icon: row.icon,
    source: row.source,
    registryId: row.registryId,
    transport: row.transport,
    runtime: row.runtime,
    config: toMcpServerConfig(row),
    status: row.status,
    statusMessage: row.statusMessage,
    tools: row.tools,
    resources: row.resources,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * One connector belonging to this user, or `null`.
 *
 * Six routes take this path and all six are scoped by `oxyUserId`, exactly as
 * the source was — an id alone must not reach another account's connector.
 *
 * `id` is `text`, so an id of any shape simply fails to match. Mongo answered a
 * malformed `ObjectId` with a `CastError` the route turned into a 500; this
 * returns the 404 the caller deserved. Quieter, and in the right direction —
 * pinned by a test, because a change from loud to quiet is worth a test whichever
 * way it points.
 */
export async function findMcpServerForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<McpServerRow | null> {
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.oxyUserId, oxyUserId)))
    .limit(1);

  return row ?? null;
}

/** One connector by the name it was installed under, for the idempotent install. */
export async function findMcpServerByName(
  db: ApiDatabase,
  oxyUserId: string,
  name: string,
): Promise<McpServerRow | null> {
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.oxyUserId, oxyUserId), eq(mcpServers.name, name)))
    .limit(1);

  return row ?? null;
}

/** Every connector this user has installed, newest first. */
export async function listMcpServersForUser(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<McpServerRow[]> {
  return db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.oxyUserId, oxyUserId))
    .orderBy(desc(mcpServers.createdAt));
}

export interface NewMcpServer {
  readonly oxyUserId: string;
  readonly name: string;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly icon?: string | undefined;
  readonly source: McpServerSource;
  readonly registryId?: string | undefined;
  readonly transport: McpServerTransport;
  readonly runtime: McpServerRuntime;
  readonly config: McpServerConfig;
}

/**
 * Install a connector, or answer `null` when this user already has one by that
 * name.
 *
 * `null` is the answer `mcp_servers_oxy_user_name_key` gives, and the route
 * turns it into either a 200 with the existing row (registry installs, so the
 * Connect flow can ensure-installed before OAuth) or a 409 (custom installs).
 * `ON CONFLICT DO NOTHING` rather than a caught error, for the reason the event
 * log states: a thrown constraint violation aborts a surrounding transaction and
 * the recovery read would go with it.
 *
 * That unique index did NOT exist in Postgres before this change — it is the one
 * declaration of this slice's twenty-six the schema batch missed. Without it the
 * insert always succeeds and every Connect attempt silently installs another
 * copy.
 */
export async function installMcpServer(
  db: ApiDatabase,
  input: NewMcpServer,
): Promise<McpServerRow | null> {
  const [row] = await db
    .insert(mcpServers)
    .values({
      oxyUserId: input.oxyUserId,
      name: input.name,
      displayName: input.displayName,
      description: input.description ?? null,
      icon: input.icon ?? null,
      source: input.source,
      registryId: input.registryId ?? null,
      transport: input.transport,
      runtime: input.runtime,
      configCommand: input.config.command ?? null,
      configArgs: input.config.args ?? null,
      configUrl: input.config.url ?? null,
      configHeaders: input.config.headers ?? null,
      configEnv: input.config.env ?? null,
      configRequiresOauth: input.config.requiresOAuth ?? null,
      status: 'installed',
    })
    .onConflictDoNothing({ target: [mcpServers.oxyUserId, mcpServers.name] })
    .returning();

  return row ?? null;
}

/** Remove a connector belonging to this user, returning what was removed. */
export async function deleteMcpServerForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<McpServerRow | null> {
  const [row] = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.oxyUserId, oxyUserId)))
    .returning();

  return row ?? null;
}

/** What `PATCH /mcp/:id` is allowed to change. */
export interface McpServerPatch {
  readonly config?: McpServerConfig | undefined;
  readonly enabled?: boolean | undefined;
  readonly runtime?: McpServerRuntime | undefined;
}

/**
 * Apply a patch and return the updated row.
 *
 * `config` MERGES rather than replaces, which is what `server.config = { ...server.config,
 * ...config }` did — and the merge has to be per-KEY, because the columns are
 * flat. A key the caller did not send keeps its stored value; a key sent as
 * `null` clears it. JSON cannot carry `undefined`, so those two are the only
 * cases a request can express, and `in` is what tells them apart —
 * `patch.config.url === undefined` cannot, since it is also what an absent key
 * reads as.
 */
export async function updateMcpServer(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
  patch: McpServerPatch,
): Promise<McpServerRow | null> {
  const set: Partial<typeof mcpServers.$inferInsert> = {};

  if (patch.config !== undefined) {
    const c = patch.config;
    if ('command' in c) set.configCommand = c.command ?? null;
    if ('args' in c) set.configArgs = c.args ?? null;
    if ('url' in c) set.configUrl = c.url ?? null;
    if ('headers' in c) set.configHeaders = c.headers ?? null;
    if ('env' in c) set.configEnv = c.env ?? null;
    if ('requiresOAuth' in c) set.configRequiresOauth = c.requiresOAuth ?? null;
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.runtime !== undefined) set.runtime = patch.runtime;

  // An empty patch is a legitimate request — the source's three `!== undefined`
  // guards could all miss — and `db.update()` with no columns is a syntax error.
  // Answer with the current row rather than raising.
  if (Object.keys(set).length === 0) return findMcpServerForUser(db, id, oxyUserId);

  const [row] = await db
    .update(mcpServers)
    .set(set)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.oxyUserId, oxyUserId)))
    .returning();

  return row ?? null;
}

/** What a start / stop / OAuth-finish outcome records. */
export interface McpServerStatusPatch {
  readonly status: McpServerStatus;
  readonly statusMessage?: string | null | undefined;
  readonly tools?: McpServerTool[] | undefined;
  readonly resources?: McpServerResource[] | undefined;
  readonly requiresOAuth?: boolean | undefined;
}

/**
 * Record what became of a connector after a call to the integrations service.
 *
 * `tools` and `resources` are only written when the response CARRIED them —
 * `if (data.tools) server.tools = data.tools` in the source — so an integrations
 * reply that omits them leaves the last known capability listing in place rather
 * than blanking it. Spread rather than `?? null` for the same reason the event
 * log spreads `agentSessionId`.
 */
export async function setMcpServerStatus(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
  patch: McpServerStatusPatch,
): Promise<McpServerRow | null> {
  const [row] = await db
    .update(mcpServers)
    .set({
      status: patch.status,
      ...(patch.statusMessage === undefined ? {} : { statusMessage: patch.statusMessage }),
      ...(patch.tools === undefined ? {} : { tools: patch.tools }),
      ...(patch.resources === undefined ? {} : { resources: patch.resources }),
      ...(patch.requiresOAuth === undefined ? {} : { configRequiresOauth: patch.requiresOAuth }),
    })
    .where(and(eq(mcpServers.id, id), eq(mcpServers.oxyUserId, oxyUserId)))
    .returning();

  return row ?? null;
}

/**
 * The connectors the chat tool builder dispatches to: enabled, running, and
 * hosted in the integrations service rather than on the user's own machine.
 *
 * All four predicates are the source's, and none is optional — a `local` runtime
 * has no integrations-side process to call, and a `stopped` one would answer
 * every tool call with a connection error.
 */
export async function listRunnableMcpServersForUser(
  db: ApiDatabase,
  oxyUserId: string,
  /**
   * The connectors this turn may use, or `undefined` for every runnable one.
   *
   * An EMPTY array is a real answer — "these zero connectors" — and returns
   * nothing rather than everything. It is what an agent granted no connector
   * asks, and `inArray(col, [])` is a shape drizzle has changed its handling
   * of, so the empty case is answered before a statement is built.
   */
  selectedServerIds?: readonly string[],
): Promise<McpServerRow[]> {
  if (selectedServerIds !== undefined && selectedServerIds.length === 0) return [];
  return db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.oxyUserId, oxyUserId),
        eq(mcpServers.enabled, true),
        eq(mcpServers.status, 'running'),
        eq(mcpServers.runtime, 'server'),
        ...(selectedServerIds === undefined
          ? []
          : [inArray(mcpServers.id, [...selectedServerIds])]),
      ),
    );
}
