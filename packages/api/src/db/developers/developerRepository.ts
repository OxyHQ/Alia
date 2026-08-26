/**
 * The developer platform — registered apps and the API keys that call Alia —
 * on Postgres.
 *
 * ## Every app read is scoped by `oxy_user_id`, and that is not decoration
 *
 * The routes look an app up by `{ _id, oxyUserId }`, never by id alone: the
 * ownership check IS the lookup, so a caller cannot name someone else's app and
 * get a 404-versus-403 distinction out of it. Every function here that takes an
 * app id takes the owner too, so the pattern cannot be lost by using a
 * conveniently narrower one.
 *
 * ## `key_hash` is protected, and a hash is still an oracle
 *
 * `keyHash` is a sha256 of a live credential. Anyone holding a candidate key can
 * confirm it against the column, so it is not a safer thing to expose than the
 * key. Nothing here returns it; `keyPrefix` is the only identifier safe to show
 * or log. `hashDeveloperApiKey` in `apiKeyCrypto.ts` is the one place the digest
 * is computed.
 *
 * ## `id` is a uuid v7 string, where Mongo had an ObjectId
 *
 * Callers used `_id.toString()`. The column is `text`, so the conversion is gone
 * rather than ported — but an app id from an OLD client is an ObjectId hex
 * string that matches nothing, which is a 404 rather than a crash.
 *
 * ## There is no INSERT here, and that is the point
 *
 * ADR 0001 gives developer applications and credentials to Oxy, and #139
 * workstream 11 closes issuance on this side. `insertApp` and `insertApiKey` are
 * deleted rather than left unused behind a refusing route: an exported writer
 * with no caller is a re-opened door one import away, and it reads as ordinary
 * infrastructure to anyone who arrives later. The two by-name lookups that fed
 * the desktop auto-registration (`findOwnedAppByName`, `findOwnedKeyByName`) go
 * with it — the flow they served is closed, so they answered a question nobody
 * asks.
 *
 * Read, update, revoke and delete all remain: section (c) of
 * `docs/migration/compatibility-window.md` keeps every issued credential working
 * and explicitly keeps revocation available, because taking that away during a
 * migration would be a security regression.
 *
 * The Postgres suite seeds its own rows with SQL for the same reason. A fixture
 * that inserts is a fixture; an exported function that inserts is an API.
 */

import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { developerApiKeys, developerApps } from '../schema/developers';

export type DeveloperAppRow = typeof developerApps.$inferSelect;
export type DeveloperAppInsert = typeof developerApps.$inferInsert;
export type DeveloperApiKeyRow = typeof developerApiKeys.$inferSelect;
export type DeveloperApiKeyInsert = typeof developerApiKeys.$inferInsert;

/**
 * What `routes/developer.ts` puts on the wire.
 *
 * ## `_id` is a versioned contract, and dropping it corrupts a list rather than erroring
 *
 * `packages/alia-console/src/hooks/use-developer.ts` declares `_id: string` on
 * both `DeveloperApp` and `DeveloperApiKey`, and does not merely display it — it
 * compares on it. Serving a row with `id` and no `_id` leaves `app._id ===
 * updatedApp._id` reading `undefined === undefined`, which is TRUE for every
 * app, so renaming one app rewrites the whole cached list; and `key._id !==
 * keyId` becomes always-true, so a deleted key never leaves the list. Nothing
 * throws and nothing logs. So `_id` is served from the Postgres `id`, exactly as
 * `library_files` does, and it retires when no supported client reads it.
 *
 * `keyHash` is absent from `DeveloperApiKeyResponse` BY TYPE, not by deletion:
 * a hash of a live credential is an exact-match oracle for anyone holding a
 * candidate key, so a new response shape has to opt in rather than remember to
 * opt out.
 *
 * The flattened `rateLimit*` columns are deliberately NOT reassembled into the
 * nested `rateLimit` object Mongo stored. No client reads it — measured across
 * `packages/alia-console/src` and `packages/app`, zero occurrences — and
 * `middleware/api-key-rate-limit.ts` rebuilds the nested shape it needs from the
 * columns directly.
 */
export interface DeveloperAppResponse extends DeveloperAppRow {
  readonly _id: string;
}

export type DeveloperApiKeyResponse = Omit<DeveloperApiKeyRow, 'keyHash'> & {
  readonly _id: string;
};

export function toDeveloperAppResponse(row: DeveloperAppRow): DeveloperAppResponse {
  return { ...row, _id: row.id };
}

export function toDeveloperApiKeyResponse(row: DeveloperApiKeyRow): DeveloperApiKeyResponse {
  const { keyHash: _keyHash, ...rest } = row;
  return { ...rest, _id: row.id };
}

// ============== APPS ==============

/** One owner's apps, newest first, optionally scoped to an organization. */
export async function selectAppsForOwner(
  db: ApiDatabase,
  oxyUserId: string,
  filter: { organizationId?: string | null } = {},
): Promise<DeveloperAppRow[]> {
  const conditions: SQL[] = [eq(developerApps.oxyUserId, oxyUserId)];
  if (filter.organizationId === null) {
    conditions.push(sql`${developerApps.organizationId} is null`);
  } else if (filter.organizationId !== undefined) {
    conditions.push(eq(developerApps.organizationId, filter.organizationId));
  }
  return db
    .select()
    .from(developerApps)
    .where(and(...conditions))
    .orderBy(desc(developerApps.createdAt));
}

/** One app, but only if this account owns it. */
export async function findOwnedApp(
  db: ApiDatabase,
  appId: string,
  oxyUserId: string,
): Promise<DeveloperAppRow | null> {
  const [row] = await db
    .select()
    .from(developerApps)
    .where(and(eq(developerApps.id, appId), eq(developerApps.oxyUserId, oxyUserId)));
  return row ?? null;
}

/** One app by id alone — for the auth middleware, which has already authenticated the key. */
export async function findAppById(
  db: ApiDatabase,
  appId: string,
): Promise<DeveloperAppRow | null> {
  const [row] = await db.select().from(developerApps).where(eq(developerApps.id, appId));
  return row ?? null;
}

export type DeveloperAppUpdate = Partial<
  Pick<
    DeveloperAppInsert,
    'name' | 'description' | 'websiteUrl' | 'redirectUrls' | 'icon' | 'isActive' | 'organizationId'
  >
>;

/** Update an app the caller owns; `null` means no such app FOR THIS OWNER. */
export async function updateOwnedApp(
  db: ApiDatabase,
  appId: string,
  oxyUserId: string,
  updates: DeveloperAppUpdate,
): Promise<DeveloperAppRow | null> {
  if (Object.keys(updates).length === 0) return findOwnedApp(db, appId, oxyUserId);
  const [row] = await db
    .update(developerApps)
    .set(updates)
    .where(and(eq(developerApps.id, appId), eq(developerApps.oxyUserId, oxyUserId)))
    .returning();
  return row ?? null;
}

/**
 * Delete an app the caller owns.
 *
 * The route follows this with an explicit key deletion. That is now redundant —
 * `developer_api_keys.app_id` cascades — but it is kept: it is idempotent, it
 * costs one statement, and removing it would make the route depend silently on a
 * schema property stated nowhere near it.
 */
export async function deleteOwnedApp(
  db: ApiDatabase,
  appId: string,
  oxyUserId: string,
): Promise<DeveloperAppRow | null> {
  const [row] = await db
    .delete(developerApps)
    .where(and(eq(developerApps.id, appId), eq(developerApps.oxyUserId, oxyUserId)))
    .returning();
  return row ?? null;
}

/** How many of these apps are active. */
export async function countActiveApps(
  db: ApiDatabase,
  appIds: readonly string[],
): Promise<number> {
  if (appIds.length === 0) return 0;
  const [row] = await db
    .select({ total: count() })
    .from(developerApps)
    .where(and(inArray(developerApps.id, [...appIds]), eq(developerApps.isActive, true)));
  return row?.total ?? 0;
}

// ============== API KEYS ==============

/** One app's keys, newest first. The caller has already proved it owns the app. */
export async function selectKeysForApp(
  db: ApiDatabase,
  appId: string,
  oxyUserId: string,
): Promise<DeveloperApiKeyRow[]> {
  return db
    .select()
    .from(developerApiKeys)
    .where(and(eq(developerApiKeys.appId, appId), eq(developerApiKeys.oxyUserId, oxyUserId)))
    .orderBy(desc(developerApiKeys.createdAt));
}

/** One key, scoped to its app AND its owner. */
export async function findOwnedKey(
  db: ApiDatabase,
  keyId: string,
  appId: string,
  oxyUserId: string,
): Promise<DeveloperApiKeyRow | null> {
  const [row] = await db
    .select()
    .from(developerApiKeys)
    .where(
      and(
        eq(developerApiKeys.id, keyId),
        eq(developerApiKeys.appId, appId),
        eq(developerApiKeys.oxyUserId, oxyUserId),
      ),
    );
  return row ?? null;
}

export async function findKeyById(
  db: ApiDatabase,
  keyId: string,
): Promise<DeveloperApiKeyRow | null> {
  const [row] = await db.select().from(developerApiKeys).where(eq(developerApiKeys.id, keyId));
  return row ?? null;
}

/**
 * The key with this digest — the authentication lookup.
 *
 * Deliberately a lookup on a DETERMINISTIC digest rather than on anything
 * encrypted: a randomized-IV scheme would make this equality never match, and
 * the symptom would be a silent 401 on every authenticated request.
 */
export async function findKeyByHash(
  db: ApiDatabase,
  keyHash: string,
): Promise<DeveloperApiKeyRow | null> {
  const [row] = await db
    .select()
    .from(developerApiKeys)
    .where(eq(developerApiKeys.keyHash, keyHash));
  return row ?? null;
}

/** An ACTIVE key with this digest, for the MCP relay's cheaper check. */
export async function findActiveKeyByHash(
  db: ApiDatabase,
  keyHash: string,
): Promise<DeveloperApiKeyRow | null> {
  const [row] = await db
    .select()
    .from(developerApiKeys)
    .where(and(eq(developerApiKeys.keyHash, keyHash), eq(developerApiKeys.isActive, true)));
  return row ?? null;
}

/**
 * What may be changed about an existing key.
 *
 * `keyHash`, `keyPrefix` and `lastUsedAt` are ABSENT ON PURPOSE, and their
 * absence is a gate rather than a tidy-up.
 *
 * Under #139 workstream 11 Alia issues no new `alia_sk_*` credential. Writing a
 * fresh `keyHash` over an existing row issues one — the caller walks away holding
 * a secret that did not exist a moment ago — and it is the shape that reads as
 * maintenance rather than as minting, so it is the one most likely to come back.
 * `POST /auth/token` did exactly that, and rejecting it at the route alone would
 * leave the door standing open one import away. `keyPrefix` follows because it is
 * derived from the same secret and a prefix that disagrees with the digest turns
 * every support conversation into a wrong answer. `lastUsedAt` follows because
 * the same path reset it to `null` to disguise a replaced key as a new one;
 * `touchKeyLastUsed` is the only legitimate writer, and it takes no caller input.
 *
 * `Pick` is what enforces this: naming a column here is the only way to write it
 * through {@link updateOwnedKey}, so a reintroduced rotation fails to compile
 * rather than shipping. `bun run --filter @alia/api typecheck` is the check —
 * `middleware/__tests__/credential-deprecation.test.ts` asserts the same property
 * with a compile-time `AssertNever`, because a runtime test cannot observe the
 * absence of a type.
 */
export type DeveloperApiKeyUpdate = Partial<
  Pick<
    DeveloperApiKeyInsert,
    | 'name'
    | 'scopes'
    | 'isActive'
    | 'expiresAt'
    | 'rateLimitRequestsPerMinute'
    | 'rateLimitRequestsPerDay'
    | 'rateLimitTokensPerMinute'
    | 'rateLimitTokensPerDay'
  >
>;

/** Update a key the caller owns; `null` means no such key for this app and owner. */
export async function updateOwnedKey(
  db: ApiDatabase,
  keyId: string,
  appId: string,
  oxyUserId: string,
  updates: DeveloperApiKeyUpdate,
): Promise<DeveloperApiKeyRow | null> {
  if (Object.keys(updates).length === 0) return findOwnedKey(db, keyId, appId, oxyUserId);
  const [row] = await db
    .update(developerApiKeys)
    .set(updates)
    .where(
      and(
        eq(developerApiKeys.id, keyId),
        eq(developerApiKeys.appId, appId),
        eq(developerApiKeys.oxyUserId, oxyUserId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteOwnedKey(
  db: ApiDatabase,
  keyId: string,
  appId: string,
  oxyUserId: string,
): Promise<DeveloperApiKeyRow | null> {
  const [row] = await db
    .delete(developerApiKeys)
    .where(
      and(
        eq(developerApiKeys.id, keyId),
        eq(developerApiKeys.appId, appId),
        eq(developerApiKeys.oxyUserId, oxyUserId),
      ),
    )
    .returning();
  return row ?? null;
}

/** Delete every key of one app. */
export async function deleteKeysForApp(
  db: ApiDatabase,
  appId: string,
  oxyUserId: string,
): Promise<number> {
  const result = await db
    .delete(developerApiKeys)
    .where(and(eq(developerApiKeys.appId, appId), eq(developerApiKeys.oxyUserId, oxyUserId)));
  return result.count ?? 0;
}

/**
 * Record that a key was just used.
 *
 * Fire-and-forget at the call site, as it was: a failure to stamp
 * `last_used_at` must not fail the request it is describing.
 */
export async function touchKeyLastUsed(db: ApiDatabase, keyId: string): Promise<void> {
  await db
    .update(developerApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(developerApiKeys.id, keyId));
}

export async function countKeysForApps(
  db: ApiDatabase,
  appIds: readonly string[],
  oxyUserId: string,
  filter: { isActive?: boolean } = {},
): Promise<number> {
  if (appIds.length === 0) return 0;
  const conditions: SQL[] = [
    inArray(developerApiKeys.appId, [...appIds]),
    eq(developerApiKeys.oxyUserId, oxyUserId),
  ];
  if (filter.isActive !== undefined) {
    conditions.push(eq(developerApiKeys.isActive, filter.isActive));
  }
  const [row] = await db
    .select({ total: count() })
    .from(developerApiKeys)
    .where(and(...conditions));
  return row?.total ?? 0;
}

export interface ApiKeyWithApp {
  readonly key: DeveloperApiKeyRow;
  readonly app: DeveloperAppRow | null;
}

/**
 * A key together with its app — the `.populate('appId')` the Codea routes used.
 *
 * A LEFT join, because `populate` yielded null for a missing app rather than
 * dropping the key: the routes read `apiKey?.appId?.name` with a fallback, and an
 * inner join would turn a missing app into a missing KEY and a spurious 401.
 */
export async function findKeyWithApp(
  db: ApiDatabase,
  keyId: string,
): Promise<ApiKeyWithApp | null> {
  const [row] = await db
    .select({ key: developerApiKeys, app: developerApps })
    .from(developerApiKeys)
    .leftJoin(developerApps, eq(developerApiKeys.appId, developerApps.id))
    .where(eq(developerApiKeys.id, keyId));
  return row ?? null;
}
