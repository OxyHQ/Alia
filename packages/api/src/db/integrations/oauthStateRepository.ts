/**
 * The integrations OAuth `state`, on Postgres.
 *
 * The token IS the primary key — Mongo declared `_id: String` and wrote the
 * random state into it, and `oauth_states.id` is `text` with no default for the
 * same reason: a minted id would produce a row the callback could never find.
 *
 * It is a credential, stored in the clear and matched on by value, so the same
 * rule as `mcp_oauth_states.state` applies — never `encryptedText`, because a
 * randomized IV makes the equality lookup match nothing and every OAuth flow
 * then reads as "expired".
 *
 * ## Validity is decided here, in one place, for one reason
 *
 * Both readers in `routes/integrations-oauth.ts` wrote the same three-part test
 * by hand: the row exists, its `service` matches the route's, and `expires_at`
 * is in the future. All three produced the SAME error — `oauth_expired` /
 * "Invalid or expired state" — which is the correct design (a client must not be
 * able to vary one input at a time and read out which part failed), and it is
 * also exactly why they belong in one predicate rather than in two hand-written
 * copies that could drift apart.
 */

import { and, eq, gt } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { oauthStates } from '../schema/integrations';

/** How long an authorize has to come back. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStateRow {
  readonly id: string;
  readonly service: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

/** Mint a state for an authorize that is about to start. */
export async function createOAuthState(
  db: ApiDatabase,
  input: { state: string; service: string; userId: string; expiresAt: Date },
): Promise<void> {
  await db.insert(oauthStates).values({
    id: input.state,
    service: input.service,
    userId: input.userId,
    expiresAt: input.expiresAt,
  });
}

/**
 * The state behind this token FOR THIS SERVICE, or `null` when it is unknown,
 * belongs to another service, or has expired.
 *
 * Does NOT consume it: the authenticated `/complete` call verifies the caller
 * owns it first, so a mismatched caller cannot burn the initiating user's state.
 */
export async function findLiveOAuthState(
  db: ApiDatabase,
  state: string,
  service: string,
  now: Date = new Date(),
): Promise<OAuthStateRow | null> {
  const [row] = await db
    .select({
      id: oauthStates.id,
      service: oauthStates.service,
      userId: oauthStates.userId,
      expiresAt: oauthStates.expiresAt,
    })
    .from(oauthStates)
    .where(
      and(
        eq(oauthStates.id, state),
        eq(oauthStates.service, service),
        gt(oauthStates.expiresAt, now),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Consume a state, single-use. `true` when this call was the one that took it.
 *
 * The atomicity is what matters and it is the reason this is a `DELETE …
 * RETURNING` rather than a read followed by a delete: two requests racing
 * between the load above and here both see a live state, and exactly one gets a
 * row back from this.
 */
export async function consumeOAuthState(db: ApiDatabase, state: string): Promise<boolean> {
  const rows = await db
    .delete(oauthStates)
    .where(eq(oauthStates.id, state))
    .returning({ id: oauthStates.id });

  return rows.length > 0;
}
