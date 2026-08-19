/**
 * MCP Connector OAuth Store, on Postgres.
 *
 * Per-(user, server) persistence backing the `AliaOAuthProvider`
 * `OAuthClientProvider` implementation. Holds the three artifacts the MCP SDK
 * OAuth lifecycle needs — the Dynamic Client Registration client info, the
 * issued OAuth tokens, and the in-flight PKCE code verifier — plus the
 * interactive authorization URL captured during the redirect step.
 *
 * ## The at-rest format is UNCHANGED by this port, deliberately
 *
 * Encryption lives in the PROVIDER, not in the column. `oauth-provider.ts`
 * calls `encrypt()` from `../shared/crypto` (AES-256-GCM, `iv:authTag:cipher`
 * hex, keyed by `TOKEN_ENCRYPTION_KEY`) before handing a value here, and
 * `decrypt()` after reading one back; the columns are plain `text` holding
 * opaque strings, which is exactly what the Mongoose schema did.
 *
 * Both directions of getting this wrong are silent:
 *
 *  - A plain `text` column with the encryption REMOVED from the provider stores
 *    live OAuth tokens in the clear, and every read still succeeds.
 *  - An `encryptedText` custom type ADDED to the column while the provider
 *    still encrypts produces ciphertext-of-ciphertext. The write succeeds, the
 *    row looks perfectly stored, and every OAuth call fails at the first read.
 *
 * `packages/api` has an `encryptedText` custom type for columns whose Mongoose
 * counterpart carried a field-level `set: encrypt, get: decrypt`. These columns
 * did NOT: they were plain `String` with the provider encrypting. So the codec
 * belongs where it already is, and this schema stays plain `text` —
 * `db/schema/columns.ts` in this package deliberately declares no such type.
 *
 * `mcp_connector_auths` is written and read by this process only; `packages/api`
 * reaches MCP over HTTP with `X-Gateway-Secret` and owns no such table, and
 * nothing else reads these rows. `TOKEN_ENCRYPTION_KEY` still has to hold
 * across a redeploy of THIS process, though: the rows persist, so a changed
 * key cannot decrypt a connector a user authorized under the old one. That
 * shows up as an authorization error at the OAuth call site, not a decryption
 * one here — which is why it gets misdiagnosed.
 */

import { and, eq } from 'drizzle-orm';
import type { IntegrationsDatabase } from '../db';
import { mcpConnectorAuths } from '../db/schema';

/**
 * One connector's OAuth record. Every secret field is CIPHERTEXT; only
 * `authorizationUrl` is readable as-is.
 */
export interface McpConnectorAuthRow {
  readonly id: string;
  readonly clientInformation: string | null;
  readonly tokens: string | null;
  readonly codeVerifier: string | null;
  readonly authorizationUrl: string | null;
}

/** The columns the provider reads. Named, because three of them are protected. */
const AUTH_COLUMNS = {
  id: mcpConnectorAuths.id,
  clientInformation: mcpConnectorAuths.clientInformation,
  tokens: mcpConnectorAuths.tokens,
  codeVerifier: mcpConnectorAuths.codeVerifier,
  authorizationUrl: mcpConnectorAuths.authorizationUrl,
} as const;

/**
 * Load, or atomically create, the auth record for a (user, server) pair.
 *
 * `ON CONFLICT DO NOTHING` then a read, rather than a read then an insert: two
 * OAuth callbacks racing for one (user, server) must converge on a single row
 * instead of leaving two half-finished authorizations. `DO NOTHING` is also
 * what keeps the loser from clobbering a record the winner has already begun
 * writing tokens into — Mongo's `$setOnInsert` upsert had the same property.
 *
 * The follow-up `SELECT` is unconditional because `DO NOTHING` returns no row
 * for the loser. `RETURNING` alone would hand back `undefined` there, which is
 * indistinguishable from a failure.
 */
export async function getOrCreateConnectorAuth(
  db: IntegrationsDatabase,
  oxyUserId: string,
  serverId: string,
): Promise<McpConnectorAuthRow> {
  await db.insert(mcpConnectorAuths).values({ oxyUserId, serverId }).onConflictDoNothing({
    target: [mcpConnectorAuths.oxyUserId, mcpConnectorAuths.serverId],
  });

  const [row] = await db
    .select(AUTH_COLUMNS)
    .from(mcpConnectorAuths)
    .where(
      and(eq(mcpConnectorAuths.oxyUserId, oxyUserId), eq(mcpConnectorAuths.serverId, serverId)),
    )
    .limit(1);

  if (!row) {
    throw new Error('Failed to load MCP connector auth record');
  }
  return row;
}

/**
 * The fields a single OAuth step writes. Each is optional because the SDK
 * writes them one at a time, and an omitted field must be left alone rather
 * than nulled — a `saveTokens` that also cleared `clientInformation` would
 * force a fresh Dynamic Client Registration on the next call.
 */
export interface ConnectorAuthUpdate {
  readonly clientInformation?: string;
  readonly tokens?: string;
  readonly codeVerifier?: string;
  readonly authorizationUrl?: string;
}

export async function updateConnectorAuth(
  db: IntegrationsDatabase,
  id: string,
  update: ConnectorAuthUpdate,
): Promise<void> {
  const changes: { -readonly [K in keyof ConnectorAuthUpdate]: ConnectorAuthUpdate[K] } = {};
  if (update.clientInformation !== undefined) changes.clientInformation = update.clientInformation;
  if (update.tokens !== undefined) changes.tokens = update.tokens;
  if (update.codeVerifier !== undefined) changes.codeVerifier = update.codeVerifier;
  if (update.authorizationUrl !== undefined) changes.authorizationUrl = update.authorizationUrl;
  if (Object.keys(changes).length === 0) return;

  await db.update(mcpConnectorAuths).set(changes).where(eq(mcpConnectorAuths.id, id));
}
