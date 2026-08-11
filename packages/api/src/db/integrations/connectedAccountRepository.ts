/**
 * Connected messaging accounts (WhatsApp, Telegram, Signal, Gmail), on Postgres.
 *
 * ## The port CLOSES a leak, and that is deliberate rather than incidental
 *
 * `connected_accounts.oauth_access_token` / `oauth_refresh_token` are
 * `encryptedText`, and in Mongoose the same pair lived in an `oauthTokens`
 * sub-document declared `{ toJSON: { getters: true } }` with **no
 * `select: false`**. Every route here answered `res.json({ account })` with the
 * whole document — so a Gmail access token scoped `gmail.send`, ciphertext at
 * rest, went onto the wire in the CLEAR on `GET /accounts`, `GET /:id/status`
 * and `PATCH /:id/settings`.
 *
 * Measured, not inferred: hydrating the model and `JSON.stringify`-ing it the
 * way Express does yields the plaintext, with a control string absent from the
 * document confirming the check is not a substring accident.
 *
 * `ConnectedAccountSafeRow` has no token field, so the leak closes by
 * construction. Nothing reads what it drops —
 * `packages/app/lib/hooks/use-connected-accounts.ts:6` declares the DTO and
 * `oauthTokens` is not in it. `bots.bot_token` had `select: false` and so keeps
 * a guarantee it already had; this column never had one, which is why the
 * difference is called out rather than absorbed.
 *
 * The tokens are still WRITTEN — the Gmail callback stores them and forwards
 * them to the integrations service in the same request — and there is
 * deliberately no reader for them here. When one is needed it should look like
 * `findEnabledIntegrationTokens`: one named function, projecting the two
 * columns, and nothing else.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { connectedAccounts, type ConnectedAccountStatus } from '../schema/integrations';

/** A connected account WITHOUT its OAuth tokens — the shape every response serves. */
export interface ConnectedAccountSafeRow {
  _id: string;
  id: string;
  platform: string;
  accountId: string;
  displayName: string | null;
  phoneNumber: string | null;
  email: string | null;
  avatarUrl: string | null;
  status: ConnectedAccountStatus;
  statusMessage: string | null;
  sessionId: string | null;
  capabilities: string[];
  autoReply: boolean;
  autoReplyAgentId: string | null;
  customContext: string | null;
  allowedTools: string[] | null;
  blockedTools: string[] | null;
  allowedSkillIds: string[] | null;
  metadata: Record<string, unknown>;
  lastActiveAt: Date | null;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SAFE_COLUMNS = {
  id: connectedAccounts.id,
  platform: connectedAccounts.platform,
  accountId: connectedAccounts.accountId,
  displayName: connectedAccounts.displayName,
  phoneNumber: connectedAccounts.phoneNumber,
  email: connectedAccounts.email,
  avatarUrl: connectedAccounts.avatarUrl,
  status: connectedAccounts.status,
  statusMessage: connectedAccounts.statusMessage,
  sessionId: connectedAccounts.sessionId,
  capabilities: connectedAccounts.capabilities,
  autoReply: connectedAccounts.autoReply,
  autoReplyAgentId: connectedAccounts.autoReplyAgentId,
  customContext: connectedAccounts.customContext,
  allowedTools: connectedAccounts.allowedTools,
  blockedTools: connectedAccounts.blockedTools,
  allowedSkillIds: connectedAccounts.allowedSkillIds,
  metadata: connectedAccounts.metadata,
  lastActiveAt: connectedAccounts.lastActiveAt,
  connectedAt: connectedAccounts.connectedAt,
  createdAt: connectedAccounts.createdAt,
  updatedAt: connectedAccounts.updatedAt,
} as const;

function withLegacyId(row: Omit<ConnectedAccountSafeRow, '_id'>): ConnectedAccountSafeRow {
  return { _id: row.id, ...row };
}

/**
 * Every connected account for this user, newest first, optionally one platform.
 *
 * The two list routes differed only by the `platform` filter, so they are one
 * function with an optional argument rather than two that can drift.
 */
export async function listConnectedAccountsForUser(
  db: ApiDatabase,
  oxyUserId: string,
  platform?: string,
): Promise<ConnectedAccountSafeRow[]> {
  const rows = await db
    .select(SAFE_COLUMNS)
    .from(connectedAccounts)
    .where(
      platform === undefined
        ? eq(connectedAccounts.oxyUserId, oxyUserId)
        : and(
            eq(connectedAccounts.oxyUserId, oxyUserId),
            eq(connectedAccounts.platform, platform),
          ),
    )
    .orderBy(desc(connectedAccounts.createdAt));

  return rows.map(withLegacyId);
}

/** One connected account belonging to this user, or `null`. */
export async function findConnectedAccountForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<ConnectedAccountSafeRow | null> {
  const [row] = await db
    .select(SAFE_COLUMNS)
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.oxyUserId, oxyUserId)))
    .limit(1);

  return row ? withLegacyId(row) : null;
}

/**
 * Create the `connecting` placeholder every connect flow starts from.
 *
 * The Gmail route used to pre-mint an `ObjectId`, fire `save()` WITHOUT awaiting
 * it, and answer 200 with that id whether or not the write landed — so a failed
 * save produced an id the client would then poll forever. This awaits, which
 * means a storage failure now surfaces as a 500 instead of as a phantom
 * account. Stated because it is a behaviour change, and it is the direction that
 * turns a plausible wrong answer into an error.
 */
export async function createPendingConnectedAccount(
  db: ApiDatabase,
  input: { oxyUserId: string; platform: string; capabilities: string[] },
): Promise<ConnectedAccountSafeRow> {
  const [row] = await db
    .insert(connectedAccounts)
    .values({
      oxyUserId: input.oxyUserId,
      platform: input.platform,
      accountId: 'pending',
      status: 'connecting',
      capabilities: input.capabilities,
    })
    .returning(SAFE_COLUMNS);

  if (!row) throw new Error('connected account insert returned no row');
  return withLegacyId(row);
}

/** Attach the integrations-service session id. */
export async function setConnectedAccountSession(
  db: ApiDatabase,
  id: string,
  sessionId: string,
): Promise<void> {
  await db.update(connectedAccounts).set({ sessionId }).where(eq(connectedAccounts.id, id));
}

/** Record a status the integrations service reported, or a local disconnect. */
export interface ConnectedAccountStatusPatch {
  readonly status: ConnectedAccountStatus;
  readonly phoneNumber?: string | undefined;
  readonly displayName?: string | undefined;
  readonly accountId?: string | undefined;
  readonly connectedAt?: Date | undefined;
}

/**
 * Apply a status sync.
 *
 * Every optional field is spread rather than defaulted to `null`, matching the
 * source's `if (statusData.phoneNumber) …` — a status poll that omits a display
 * name must not erase the one already stored.
 */
export async function setConnectedAccountStatus(
  db: ApiDatabase,
  id: string,
  patch: ConnectedAccountStatusPatch,
): Promise<ConnectedAccountSafeRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({
      status: patch.status,
      ...(patch.phoneNumber === undefined ? {} : { phoneNumber: patch.phoneNumber }),
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.accountId === undefined ? {} : { accountId: patch.accountId }),
      ...(patch.connectedAt === undefined ? {} : { connectedAt: patch.connectedAt }),
    })
    .where(eq(connectedAccounts.id, id))
    .returning(SAFE_COLUMNS);

  return row ? withLegacyId(row) : null;
}

/**
 * Complete a Gmail link: identity, status, and the OAuth group as a WHOLE.
 *
 * `connected_accounts_oauth_pair_check` refuses a half-written group — a refresh
 * token or an expiry with no access token — which Mongo could not express,
 * because the sub-document's `required` only applied when the sub-document was
 * present at all. So the four columns are written together here, and the
 * database rejects any other combination rather than storing it.
 */
export async function completeGmailConnection(
  db: ApiDatabase,
  id: string,
  input: {
    email: string;
    displayName: string;
    accessToken: string;
    refreshToken?: string | undefined;
    expiresAt?: Date | undefined;
    scope: string;
  },
): Promise<ConnectedAccountSafeRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({
      status: 'connected',
      accountId: input.email,
      email: input.email,
      displayName: input.displayName,
      connectedAt: new Date(),
      oauthAccessToken: input.accessToken,
      oauthRefreshToken: input.refreshToken ?? null,
      oauthExpiresAt: input.expiresAt ?? null,
      oauthScope: input.scope,
    })
    .where(eq(connectedAccounts.id, id))
    .returning(SAFE_COLUMNS);

  return row ? withLegacyId(row) : null;
}

/** What `PATCH /accounts/:id/settings` is allowed to change. */
export interface ConnectedAccountSettingsPatch {
  readonly autoReply?: boolean | undefined;
  readonly autoReplyAgentId?: string | null | undefined;
  readonly customContext?: string | null | undefined;
  readonly allowedTools?: string[] | null | undefined;
  readonly blockedTools?: string[] | null | undefined;
  readonly allowedSkillIds?: string[] | null | undefined;
}

/**
 * Apply a settings patch, returning the updated row.
 *
 * ## `undefined` meant UNSET in Mongo and means NOTHING here
 *
 * The source read `autoReplyAgentId ? new ObjectId(id) : undefined` and assigned
 * it to the document, which UNSET the field — so sending `autoReplyAgentId: null`
 * was how a user turned auto-reply's agent binding off. `.set({ x: undefined })`
 * in drizzle is a silent no-op: the agent would stay bound, and the UI would show
 * it cleared. Every clearable field below therefore maps a falsy-but-present
 * value to an explicit `null`, and `!== undefined` is what distinguishes "the
 * client sent this" from "the client did not mention it".
 */
export async function updateConnectedAccountSettings(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
  patch: ConnectedAccountSettingsPatch,
): Promise<ConnectedAccountSafeRow | null> {
  const set: Partial<typeof connectedAccounts.$inferInsert> = {};

  if (patch.autoReply !== undefined) set.autoReply = patch.autoReply;
  if (patch.autoReplyAgentId !== undefined) set.autoReplyAgentId = patch.autoReplyAgentId || null;
  if (patch.customContext !== undefined) set.customContext = patch.customContext ?? null;
  if (patch.allowedTools !== undefined) set.allowedTools = patch.allowedTools ?? null;
  if (patch.blockedTools !== undefined) set.blockedTools = patch.blockedTools ?? null;
  if (patch.allowedSkillIds !== undefined) set.allowedSkillIds = patch.allowedSkillIds ?? null;

  // An empty patch is a legitimate request and `db.update()` with no columns is
  // a syntax error, so answer with the current row rather than raising.
  if (Object.keys(set).length === 0) return findConnectedAccountForUser(db, id, oxyUserId);

  const [row] = await db
    .update(connectedAccounts)
    .set(set)
    .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.oxyUserId, oxyUserId)))
    .returning(SAFE_COLUMNS);

  return row ? withLegacyId(row) : null;
}

/** Remove an account belonging to this user, returning what was removed. */
export async function deleteConnectedAccountForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<ConnectedAccountSafeRow | null> {
  const [row] = await db
    .delete(connectedAccounts)
    .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.oxyUserId, oxyUserId)))
    .returning(SAFE_COLUMNS);

  return row ? withLegacyId(row) : null;
}

/**
 * Remove a placeholder the connect flow failed to complete.
 *
 * Not user-scoped: the caller created the row moments earlier and holds its id,
 * exactly as the source's `account.deleteOne()` was.
 */
export async function deleteConnectedAccount(db: ApiDatabase, id: string): Promise<void> {
  await db.delete(connectedAccounts).where(eq(connectedAccounts.id, id));
}

/**
 * This user's CONNECTED account on one platform, for outbound delivery.
 *
 * `status: 'connected'` is in the filter rather than checked afterwards, exactly
 * as the source had it — an account still `connecting`, or `expired`, has no
 * live session to send through, and a caller that read the row and forgot to
 * look would send into nothing and report success.
 */
export async function findConnectedAccountForChannel(
  db: ApiDatabase,
  oxyUserId: string,
  platform: string,
): Promise<ConnectedAccountSafeRow | null> {
  const [row] = await db
    .select(SAFE_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.oxyUserId, oxyUserId),
        eq(connectedAccounts.platform, platform),
        eq(connectedAccounts.status, 'connected'),
      ),
    )
    .limit(1);

  return row ? withLegacyId(row) : null;
}
