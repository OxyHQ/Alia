/**
 * The MCP connector's single-use OAuth `state`, on Postgres.
 *
 * The `state` token IS the credential: whoever presents it recovers the
 * originating (user, server). It is stored in the clear and looked up BY VALUE,
 * which is why the column is plain `text` with a unique index and not
 * `encryptedText` — a randomized-IV ciphertext would make the callback's
 * equality lookup match nothing, and the symptom would be every OAuth flow
 * silently failing as "expired" rather than an error at write time.
 *
 * ## Expiry is decided HERE, not by each caller
 *
 * Both readers in `routes/mcp.ts` wrote the same
 * `Date.now() - createdAt.getTime() > MCP_OAUTH_STATE_TTL_SECONDS * 1000` by
 * hand. Two copies of one rule is one copy too many when the rule is "is this
 * credential still valid", so `findLiveMcpOAuthState` will not return an expired
 * row at all. The sweep in `db/expiryTargets.ts` reaps it later from the same
 * constant; this is what stops an unswept row being honoured in the meantime.
 *
 * The comparison is `>=` on the cutoff, which is the exact complement of the
 * source's `>` on the age: alive when `now - createdAt <= TTL`.
 */

import { and, eq, gte } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { MCP_OAUTH_STATE_TTL_SECONDS, mcpOauthStates } from '../schema/integrations';

export interface McpOAuthStateRow {
  readonly id: string;
  readonly oxyUserId: string;
  readonly serverId: string;
  readonly createdAt: Date;
}

/** Mint a state for an authorize that is about to start. */
export async function createMcpOAuthState(
  db: ApiDatabase,
  input: { state: string; oxyUserId: string; serverId: string },
): Promise<void> {
  await db.insert(mcpOauthStates).values({
    state: input.state,
    oxyUserId: input.oxyUserId,
    serverId: input.serverId,
  });
}

/** The state behind this token, or `null` when it is unknown OR expired. */
export async function findLiveMcpOAuthState(
  db: ApiDatabase,
  state: string,
  now: Date = new Date(),
): Promise<McpOAuthStateRow | null> {
  const cutoff = new Date(now.getTime() - MCP_OAUTH_STATE_TTL_SECONDS * 1000);

  const [row] = await db
    .select({
      id: mcpOauthStates.id,
      oxyUserId: mcpOauthStates.oxyUserId,
      serverId: mcpOauthStates.serverId,
      createdAt: mcpOauthStates.createdAt,
    })
    .from(mcpOauthStates)
    .where(and(eq(mcpOauthStates.state, state), gte(mcpOauthStates.createdAt, cutoff)))
    .limit(1);

  return row ?? null;
}

/** Consume a state by its row id, after the caller has been verified. */
export async function deleteMcpOAuthState(db: ApiDatabase, id: string): Promise<void> {
  await db.delete(mcpOauthStates).where(eq(mcpOauthStates.id, id));
}

/** Discard a state whose authorize never got off the ground. */
export async function deleteMcpOAuthStateByToken(db: ApiDatabase, state: string): Promise<void> {
  await db.delete(mcpOauthStates).where(eq(mcpOauthStates.state, state));
}
