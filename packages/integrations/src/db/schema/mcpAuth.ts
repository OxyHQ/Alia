/**
 * MCP connector OAuth state, one row per (user, server).
 *
 * Ported from `src/mcp/oauth-store.ts`. Backs the SDK's `OAuthClientProvider`:
 * the Dynamic Client Registration record, the issued tokens, and the in-flight
 * PKCE verifier.
 *
 * Every secret here arrives ALREADY encrypted (AES-256-GCM, by
 * `../shared/crypto` in the provider) and is stored as ciphertext text. The port
 * does not change that: encryption stays centralized in the provider, and the
 * database holds opaque strings. They are nonetheless registered as protected
 * columns, because `db.select()` returns every column and ciphertext plus a
 * leaked `TOKEN_ENCRYPTION_KEY` is a token.
 */

import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from '@oxyhq/db';

export const mcpConnectorAuths = pgTable(
  'mcp_connector_auths',
  {
    id: text().primaryKey(),
    oxyUserId: text().notNull(),
    serverId: text().notNull(),
    /** Encrypted JSON of the DCR client information. */
    clientInformation: text(),
    /** Encrypted JSON of the issued OAuth tokens. */
    tokens: text(),
    /** Encrypted PKCE code verifier for the in-flight authorization. */
    codeVerifier: text(),
    /**
     * The interactive authorization URL captured during redirect. Deliberately
     * NOT protected: it is what the user is sent to, carries no bearer, and is
     * needed by the surface that renders the "continue" link.
     */
    authorizationUrl: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * The upsert in `getOrCreateConnectorAuth` relies on this: concurrent OAuth
     * callbacks for one (user, server) converge on a single row instead of
     * racing two half-finished authorizations.
     */
    uniqueIndex('mcp_connector_auths_user_server_key').on(t.oxyUserId, t.serverId),
  ],
);
