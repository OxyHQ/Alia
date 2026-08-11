/**
 * Third-party OAuth integrations, on Postgres.
 *
 * ## The projection is the security property, and drizzle gives it no default
 *
 * `oauth_access_token` and `oauth_refresh_token` are `encryptedText`. Mongoose
 * expressed "do not hand these out" as `.select('-oauthTokens')` at each call
 * site; drizzle has no projection default at all, and — worse than Mongo — a
 * bare `db.select().from(integrations)` returns them **decrypted**, because
 * `fromDriver` runs on every read the query builder maps. A Mongo `find()`
 * without the getters at least yielded ciphertext.
 *
 * So there are exactly TWO shapes here, and no function returns the whole row:
 *
 *  - `IntegrationSafeRow` — every column EXCEPT the two tokens, which is what
 *    the list, status and create responses serve. It is a different TYPE, so
 *    reaching for a token off one fails `tsc` rather than leaking at runtime.
 *  - `IntegrationTokenRow` — the token bundle, returned by the ONE function
 *    that exists to refresh and use it.
 *
 * ## Nothing here looks a token up BY VALUE, and nothing may
 *
 * `encryptedText` is AES-GCM with a random IV, so the same plaintext encrypts to
 * a different value every time and an equality predicate on one of these columns
 * can never match. Every filter in this file is on `id`, `oxy_user_id`, `service`
 * or `enabled`. If a by-value lookup is ever needed the answer is a deterministic
 * keyed digest stored BESIDE the secret — never encryption of the secret itself,
 * and never plaintext. `integrations.pgdb.test.ts` pins the randomness that makes
 * this so.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { integrations, type IntegrationStatus } from '../schema/integrations';

/**
 * An integration WITHOUT its tokens — the shape every response serves.
 *
 * `_id` is carried alongside `id` because `packages/app/lib/hooks/use-integrations.ts:14`
 * reads it and a shipped mobile build cannot be recalled. What retires it is a
 * mobile release that reads `id`.
 */
export interface IntegrationSafeRow {
  _id: string;
  id: string;
  service: string;
  displayName: string;
  accountId: string | null;
  accountName: string | null;
  avatarUrl: string | null;
  status: IntegrationStatus;
  enabled: boolean;
  metadata: Record<string, unknown>;
  connectedAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The named columns of the safe projection. Used by every read below. */
const SAFE_COLUMNS = {
  id: integrations.id,
  service: integrations.service,
  displayName: integrations.displayName,
  accountId: integrations.accountId,
  accountName: integrations.accountName,
  avatarUrl: integrations.avatarUrl,
  status: integrations.status,
  enabled: integrations.enabled,
  metadata: integrations.metadata,
  connectedAt: integrations.connectedAt,
  lastUsedAt: integrations.lastUsedAt,
  createdAt: integrations.createdAt,
  updatedAt: integrations.updatedAt,
} as const;

function withLegacyId(row: Omit<IntegrationSafeRow, '_id'>): IntegrationSafeRow {
  return { _id: row.id, ...row };
}

/** Every integration this user has connected, newest first. No tokens. */
export async function listIntegrationsForUser(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<IntegrationSafeRow[]> {
  const rows = await db
    .select(SAFE_COLUMNS)
    .from(integrations)
    .where(eq(integrations.oxyUserId, oxyUserId))
    .orderBy(desc(integrations.createdAt));

  return rows.map(withLegacyId);
}

/** One integration belonging to this user, or `null`. No tokens. */
export async function findIntegrationForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<IntegrationSafeRow | null> {
  const [row] = await db
    .select(SAFE_COLUMNS)
    .from(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.oxyUserId, oxyUserId)))
    .limit(1);

  return row ? withLegacyId(row) : null;
}

/**
 * The services this user has connected and switched on.
 *
 * A projection of ONE column, which is what `.select('service')` was — the tool
 * builder needs the names and nothing else, so nothing else is read.
 */
export async function listConnectedServices(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<string[]> {
  const rows = await db
    .select({ service: integrations.service })
    .from(integrations)
    .where(
      and(
        eq(integrations.oxyUserId, oxyUserId),
        eq(integrations.enabled, true),
        eq(integrations.status, 'active'),
      ),
    );

  return rows.map((r) => r.service);
}

/** The token bundle, plus what the refresh path needs to decide and to log. */
export interface IntegrationTokenRow {
  readonly id: string;
  readonly service: string;
  readonly status: IntegrationStatus;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
}

/**
 * The ONE reader that projects the tokens.
 *
 * Filtered on `enabled` exactly as the source was. `status` is returned rather
 * than filtered on, because the caller distinguishes `revoked` (a distinct error
 * telling the user to reconnect) from merely absent.
 */
export async function findEnabledIntegrationTokens(
  db: ApiDatabase,
  oxyUserId: string,
  service: string,
): Promise<IntegrationTokenRow | null> {
  const [row] = await db
    .select({
      id: integrations.id,
      service: integrations.service,
      status: integrations.status,
      accessToken: integrations.oauthAccessToken,
      refreshToken: integrations.oauthRefreshToken,
      expiresAt: integrations.oauthExpiresAt,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.oxyUserId, oxyUserId),
        eq(integrations.service, service),
        eq(integrations.enabled, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

export interface NewIntegration {
  readonly oxyUserId: string;
  readonly service: string;
  readonly displayName: string;
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: Date | undefined;
  readonly scope: string;
  readonly tokenType: string;
  readonly accountId?: string | undefined;
  readonly accountName?: string | undefined;
  readonly avatarUrl?: string | undefined;
}

/**
 * Record a completed OAuth link, returning the SAFE shape.
 *
 * One statement where the source was two: it saved the document and then re-read
 * it with `.select('-oauthTokens')` purely to drop the tokens from the response.
 * A `returning` with the safe column list does both, and cannot answer with a
 * token because the list has none.
 *
 * The plaintext handed in here is encrypted by `encryptedText`'s `toDriver` on
 * the way to the server — there is no spelling of this insert through the query
 * builder that stores it in the clear.
 */
export async function createIntegration(
  db: ApiDatabase,
  input: NewIntegration,
): Promise<IntegrationSafeRow> {
  const [row] = await db
    .insert(integrations)
    .values({
      oxyUserId: input.oxyUserId,
      service: input.service,
      displayName: input.displayName,
      oauthAccessToken: input.accessToken,
      oauthRefreshToken: input.refreshToken ?? null,
      oauthExpiresAt: input.expiresAt ?? null,
      oauthScope: input.scope,
      oauthTokenType: input.tokenType,
      accountId: input.accountId ?? null,
      accountName: input.accountName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      status: 'active',
      connectedAt: new Date(),
    })
    .returning(SAFE_COLUMNS);

  if (!row) throw new Error('integration insert returned no row');
  return withLegacyId(row);
}

/** Remove an integration belonging to this user. `true` when one was removed. */
export async function deleteIntegrationForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<boolean> {
  const rows = await db
    .delete(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.oxyUserId, oxyUserId)))
    .returning({ id: integrations.id });

  return rows.length > 0;
}

/** Mark an integration expired or errored. Not user-scoped — the caller owns the id. */
export async function setIntegrationStatus(
  db: ApiDatabase,
  id: string,
  status: IntegrationStatus,
): Promise<void> {
  await db.update(integrations).set({ status }).where(eq(integrations.id, id));
}

/**
 * Persist a refreshed token set and return the integration to `active`.
 *
 * `refreshToken` and `expiresAt` are spread rather than passed as `null`,
 * because the source only ASSIGNED them when the provider's reply carried them
 * (`if (data.refresh_token) …`). Writing `null` instead would discard a
 * long-lived refresh token on any provider that rotates only the access token —
 * and the next refresh would then fail with "no refresh token available, please
 * reconnect", which reads as the user's problem.
 */
export async function saveRefreshedIntegrationTokens(
  db: ApiDatabase,
  id: string,
  tokens: { accessToken: string; refreshToken?: string | undefined; expiresAt?: Date | undefined },
): Promise<void> {
  await db
    .update(integrations)
    .set({
      oauthAccessToken: tokens.accessToken,
      ...(tokens.refreshToken === undefined ? {} : { oauthRefreshToken: tokens.refreshToken }),
      ...(tokens.expiresAt === undefined ? {} : { oauthExpiresAt: tokens.expiresAt }),
      status: 'active',
    })
    .where(eq(integrations.id, id));
}

/**
 * Record that a tool call used this integration.
 *
 * Fire-and-forget in both callers, and scoped by `(oxyUserId, service, enabled)`
 * exactly as the source's `updateOne` filter was — not by id, because the caller
 * has neither.
 */
export async function touchIntegrationLastUsed(
  db: ApiDatabase,
  oxyUserId: string,
  service: string,
): Promise<void> {
  await db
    .update(integrations)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(integrations.oxyUserId, oxyUserId),
        eq(integrations.service, service),
        eq(integrations.enabled, true),
      ),
    );
}
