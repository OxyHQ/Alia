/**
 * Platform bots and the people who talk to them, on Postgres.
 *
 * ## Two credentials on one table, treated OPPOSITELY, and that is the point
 *
 *  - **`bots.bot_token` is `encryptedText`.** It is only ever read to call the
 *    platform. Nothing looks a row up by it.
 *  - **`bots.webhook_secret` is PLAINTEXT and indexed**, because
 *    `findActiveUserBotByWebhookSecret` matches on it for every inbound update.
 *    `encryptedText` is AES-GCM with a random IV, so the same plaintext stores
 *    differently every time and an equality predicate against it can never
 *    match. Encrypting this column would not weaken bot routing slightly — it
 *    would break it completely, and the symptom is a silent `sendStatus(200)`
 *    on every message rather than an error at write time.
 *  - **`bot_users.auth_token` is PLAINTEXT** for the same structural reason: the
 *    redemption path finds a row by it, paired with its expiry.
 *
 * If either lookup ever has to go, the replacement is a deterministic keyed
 * digest stored BESIDE the secret — never encryption of the secret itself. The
 * realdb suite performs both lookups against real rows, so a change that made
 * the secrets "consistent" fails there rather than in production.
 *
 * ## `select: false` has no counterpart, so the projections carry it
 *
 * Mongoose omitted `bot_token` and `webhook_secret` from every query that did
 * not ask. drizzle returns whatever the column list names, so there are two
 * shapes: `BotRow` for everything the routes render, and the two credential
 * readers that name the secret they need and nothing more.
 *
 * ## The system bot is `user_id IS NULL`, and every lookup must say so
 *
 * `userId: { $exists: false }` selected the global env-configured bot;
 * `{ $exists: true }` selected a user-registered one. Getting either backwards
 * binds a global flow to somebody's private bot, which is why the two are
 * separate named functions here rather than a `userId?` parameter whose absence
 * would read as "any".
 */

import { and, desc, eq, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { botUsers, bots, type BotStatus, type BotUserAuthTokenMode } from '../schema/bots';

/** A bot as stored, WITHOUT either credential. */
export interface BotRow {
  _id: string;
  id: string;
  platform: string;
  botId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  status: BotStatus;
  userId: string | null;
  agentId: string | null;
  defaultModel: string | null;
  totalUsers: number;
  totalMessages: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Named columns, and neither credential is among them.
 *
 * `platform_config_webhook_url` / `_public_key` are absent too: every read of a
 * bot in the routes said `.select('-platformConfig')`.
 */
const BOT_COLUMNS = {
  id: bots.id,
  platform: bots.platform,
  botId: bots.botId,
  name: bots.name,
  username: bots.username,
  avatarUrl: bots.avatarUrl,
  status: bots.status,
  userId: bots.userId,
  agentId: bots.agentId,
  defaultModel: bots.defaultModel,
  totalUsers: bots.totalUsers,
  totalMessages: bots.totalMessages,
  lastMessageAt: bots.lastMessageAt,
  createdAt: bots.createdAt,
  updatedAt: bots.updatedAt,
} as const;

function withLegacyId(row: Omit<BotRow, '_id'>): BotRow {
  return { _id: row.id, ...row };
}

/**
 * The SYSTEM bot for a platform — the env-configured global one.
 *
 * `isNull(userId)` is `userId: { $exists: false }`. A bot registered by a user
 * can never match, which is what stops a global flow binding to a private bot.
 */
export async function findSystemBot(
  db: ApiDatabase,
  platform: string,
  options: { activeOnly?: boolean } = {},
): Promise<BotRow | null> {
  const [row] = await db
    .select(BOT_COLUMNS)
    .from(bots)
    .where(
      options.activeOnly
        ? and(eq(bots.platform, platform), isNull(bots.userId), eq(bots.status, 'active'))
        : and(eq(bots.platform, platform), isNull(bots.userId)),
    )
    .limit(1);

  return row ? withLegacyId(row) : null;
}

/** What the inbound webhook needs: the bot, plus the token it replies with. */
export interface InboundUserBotRow extends BotRow {
  botToken: string | null;
}

/**
 * The active USER-OWNED bot whose per-bot webhook secret the platform echoed.
 *
 * This is the by-value lookup that decides `webhook_secret` may not be
 * encrypted. All four predicates are the source's, and `isNotNull(userId)` is
 * the one that matters most: without it the GLOBAL bot's secret would select the
 * global bot here and route a system update down the per-bot path.
 *
 * Projects `bot_token` because the reply is sent with the bot's OWN token —
 * the `.select('+botToken +webhookSecret')` of the source, minus the secret,
 * which the caller already holds.
 */
export async function findActiveUserBotByWebhookSecret(
  db: ApiDatabase,
  webhookSecret: string,
  platform: string,
): Promise<InboundUserBotRow | null> {
  const [row] = await db
    .select({ ...BOT_COLUMNS, botToken: bots.botToken })
    .from(bots)
    .where(
      and(
        eq(bots.webhookSecret, webhookSecret),
        eq(bots.platform, platform),
        eq(bots.status, 'active'),
        isNotNull(bots.userId),
      ),
    )
    .limit(1);

  return row ? { ...withLegacyId(row), botToken: row.botToken } : null;
}

/** One bot by id, without credentials. */
export async function findBotById(db: ApiDatabase, id: string): Promise<BotRow | null> {
  const [row] = await db.select(BOT_COLUMNS).from(bots).where(eq(bots.id, id)).limit(1);
  return row ? withLegacyId(row) : null;
}

/** One bot by id that this user OWNS. A system bot can never match. */
export async function findOwnedBot(
  db: ApiDatabase,
  id: string,
  userId: string,
): Promise<BotRow | null> {
  const [row] = await db
    .select(BOT_COLUMNS)
    .from(bots)
    .where(and(eq(bots.id, id), eq(bots.userId, userId)))
    .limit(1);

  return row ? withLegacyId(row) : null;
}

/**
 * The owned bot plus its platform token, for the delete path's `deleteWebhook`.
 *
 * A separate function rather than a flag on `findOwnedBot`, so the one caller
 * that needs the credential is the one that names it.
 */
export async function findOwnedBotWithToken(
  db: ApiDatabase,
  id: string,
  userId: string,
): Promise<{ id: string; platform: string; botToken: string | null } | null> {
  const [row] = await db
    .select({ id: bots.id, platform: bots.platform, botToken: bots.botToken })
    .from(bots)
    .where(and(eq(bots.id, id), eq(bots.userId, userId)))
    .limit(1);

  return row ?? null;
}

/** One bot by its platform identity, for the already-registered check. */
export async function findBotByPlatformIdentity(
  db: ApiDatabase,
  platform: string,
  botId: string,
): Promise<BotRow | null> {
  const [row] = await db
    .select(BOT_COLUMNS)
    .from(bots)
    .where(and(eq(bots.platform, platform), eq(bots.botId, botId)))
    .limit(1);

  return row ? withLegacyId(row) : null;
}

/** Every non-inactive bot visible to this user: the system ones plus their own. */
export async function listVisibleBots(db: ApiDatabase, userId: string): Promise<BotRow[]> {
  const rows = await db
    .select(BOT_COLUMNS)
    .from(bots)
    .where(and(ne(bots.status, 'inactive'), or(isNull(bots.userId), eq(bots.userId, userId))))
    .orderBy(desc(bots.createdAt));

  return rows.map(withLegacyId);
}

export interface NewBot {
  readonly platform: string;
  readonly botId: string;
  readonly name: string;
  readonly username?: string | undefined;
  readonly userId: string;
  readonly agentId?: string | undefined;
  readonly botToken: string;
  readonly webhookSecret: string;
  readonly platformConfigWebhookUrl: string;
}

/**
 * Register a user-owned bot, or answer `null` when the platform identity is
 * taken.
 *
 * `bots_platform_bot_id_key` decides it. `ON CONFLICT DO NOTHING` rather than a
 * caught duplicate-key error, so no statement fails and the caller's 409 needs
 * no `catch` that could mask an unrelated failure.
 */
export async function registerBot(db: ApiDatabase, input: NewBot): Promise<BotRow | null> {
  const [row] = await db
    .insert(bots)
    .values({
      platform: input.platform,
      botId: input.botId,
      name: input.name,
      username: input.username ?? null,
      userId: input.userId,
      agentId: input.agentId ?? null,
      botToken: input.botToken,
      webhookSecret: input.webhookSecret,
      status: 'active',
      platformConfigWebhookUrl: input.platformConfigWebhookUrl,
    })
    .onConflictDoNothing({ target: [bots.platform, bots.botId] })
    .returning(BOT_COLUMNS);

  return row ? withLegacyId(row) : null;
}

/**
 * Bind or CLEAR the agent on a bot this user owns.
 *
 * `null` clears it. The source assigned `undefined`, which unset the field in
 * Mongo; `.set({ agentId: undefined })` in drizzle is a silent no-op, so an
 * explicit clear would have left the bot answering with the old agent's prompt
 * while the UI showed it unbound.
 */
export async function setBotAgent(
  db: ApiDatabase,
  id: string,
  userId: string,
  agentId: string | null,
): Promise<BotRow | null> {
  const [row] = await db
    .update(bots)
    .set({ agentId })
    .where(and(eq(bots.id, id), eq(bots.userId, userId)))
    .returning(BOT_COLUMNS);

  return row ? withLegacyId(row) : null;
}

/** Remove a bot by id. `bot_users` go with it via the FK's `ON DELETE CASCADE`. */
export async function deleteBot(db: ApiDatabase, id: string): Promise<void> {
  await db.delete(bots).where(eq(bots.id, id));
}

/**
 * Ensure a system bot exists for a configured platform.
 *
 * The source's `findOneAndUpdate({platform}, {$setOnInsert: …}, {upsert:true})`
 * — insert-or-leave-alone, never an update. `ON CONFLICT DO NOTHING` is exactly
 * that, and it means a hand-edited name or status survives a restart.
 *
 * The conflict target is `(platform, bot_id)` because that is the unique this
 * table HAS; the source filtered on `platform` alone, which was not unique, so a
 * platform whose env-derived `botId` changes now seeds a second row where Mongo
 * would have matched the first. Named here because it is a real difference: the
 * ids come from `TELEGRAM_BOT_TOKEN` / `DISCORD_APP_ID`, so it only bites when
 * those change, and the alternative — a unique on `platform` alone — would
 * forbid the user-registered bots this table exists to hold.
 */
export async function seedSystemBot(
  db: ApiDatabase,
  input: { platform: string; botId: string; name: string },
): Promise<void> {
  await db
    .insert(bots)
    .values({
      platform: input.platform,
      botId: input.botId,
      name: input.name,
      status: 'active',
    })
    .onConflictDoNothing({ target: [bots.platform, bots.botId] });
}

// ---------------------------------------------------------------------------
// bot_users
// ---------------------------------------------------------------------------

/** One person's relationship with one bot. `auth_token` is never projected. */
export interface BotUserRow {
  id: string;
  botId: string;
  platform: string;
  platformUserId: string;
  chatId: string;
  oxyUserId: string | null;
  isLinked: boolean;
  linkedAt: Date | null;
  username: string | null;
  displayName: string | null;
  authTokenExpiry: Date | null;
  authTokenMode: BotUserAuthTokenMode | null;
  conversationId: string | null;
  preferredModel: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const BOT_USER_COLUMNS = {
  id: botUsers.id,
  botId: botUsers.botId,
  platform: botUsers.platform,
  platformUserId: botUsers.platformUserId,
  chatId: botUsers.chatId,
  oxyUserId: botUsers.oxyUserId,
  isLinked: botUsers.isLinked,
  linkedAt: botUsers.linkedAt,
  username: botUsers.username,
  displayName: botUsers.displayName,
  authTokenExpiry: botUsers.authTokenExpiry,
  authTokenMode: botUsers.authTokenMode,
  conversationId: botUsers.conversationId,
  preferredModel: botUsers.preferredModel,
  metadata: botUsers.metadata,
  createdAt: botUsers.createdAt,
  updatedAt: botUsers.updatedAt,
} as const;

/** One bot user by the platform's id for the person. */
export async function findBotUser(
  db: ApiDatabase,
  botId: string,
  platformUserId: string,
): Promise<BotUserRow | null> {
  const [row] = await db
    .select(BOT_USER_COLUMNS)
    .from(botUsers)
    .where(and(eq(botUsers.botId, botId), eq(botUsers.platformUserId, platformUserId)))
    .limit(1);

  return row ?? null;
}

/** This Oxy account's LINKED relationship with a bot, if there is one. */
export async function findLinkedBotUser(
  db: ApiDatabase,
  botId: string,
  oxyUserId: string,
): Promise<BotUserRow | null> {
  const [row] = await db
    .select(BOT_USER_COLUMNS)
    .from(botUsers)
    .where(
      and(
        eq(botUsers.botId, botId),
        eq(botUsers.oxyUserId, oxyUserId),
        eq(botUsers.isLinked, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * The bot user holding this UNEXPIRED auth token.
 *
 * The second by-value lookup on a plaintext credential, and the reason
 * `bot_users.auth_token` is not `encryptedText`. The expiry is part of the
 * predicate rather than a check afterwards, exactly as
 * `authTokenExpiry: { $gt: new Date() }` was — a caller that read the row and
 * forgot to compare would honour an expired link token.
 */
export async function findBotUserByAuthToken(
  db: ApiDatabase,
  botId: string,
  authToken: string,
  now: Date = new Date(),
): Promise<BotUserRow | null> {
  const [row] = await db
    .select(BOT_USER_COLUMNS)
    .from(botUsers)
    .where(
      and(
        eq(botUsers.botId, botId),
        eq(botUsers.authToken, authToken),
        gt(botUsers.authTokenExpiry, now),
      ),
    )
    .limit(1);

  return row ?? null;
}

export interface UpsertBotUser {
  readonly botId: string;
  readonly platform: string;
  readonly platformUserId: string;
  readonly chatId: string;
  readonly username?: string | undefined;
  readonly displayName?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Create the relationship, or refresh the identity fields on an existing one.
 *
 * The source read, branched, and either constructed or mutated — a
 * read-then-write race two concurrent inbound messages from the same person can
 * lose. `ON CONFLICT … DO UPDATE` on `bot_users_bot_platform_user_key` is one
 * statement, so the loser converges instead of failing.
 *
 * Only the fields the source touched are updated, and each only when SUPPLIED —
 * `if (username) botUser.username = username` — so an update carrying no display
 * name does not blank the stored one. `metadata` MERGES, matching
 * `{ ...botUser.metadata, ...metadata }`, which is `||` on `jsonb`.
 */
export async function upsertBotUser(
  db: ApiDatabase,
  input: UpsertBotUser,
): Promise<BotUserRow> {
  const [row] = await db
    .insert(botUsers)
    .values({
      botId: input.botId,
      platform: input.platform,
      platformUserId: input.platformUserId,
      chatId: input.chatId,
      username: input.username ?? null,
      displayName: input.displayName ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [botUsers.botId, botUsers.platformUserId],
      set: {
        chatId: input.chatId,
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.metadata === undefined
          ? {}
          : { metadata: sql`${botUsers.metadata} || ${JSON.stringify(input.metadata)}::jsonb` }),
      },
    })
    .returning(BOT_USER_COLUMNS);

  if (!row) throw new Error('bot user upsert returned no row');
  return row;
}

/**
 * Redeem a link token: bind the Oxy account and CLEAR the token.
 *
 * The clearing is the security-relevant half. The source set
 * `botUser.authToken = undefined; botUser.authTokenExpiry = undefined`, which
 * UNSET both in Mongo — `.set({ authToken: undefined })` in drizzle is a silent
 * no-op, so a redeemed one-time link token would stay live until its 15-minute
 * expiry and could be redeemed again, by anyone holding it, into a DIFFERENT
 * account. Explicit `null` is what makes it single-use.
 */
export async function linkBotUser(
  db: ApiDatabase,
  id: string,
  input: { oxyUserId: string; sessionToken?: string | undefined },
): Promise<BotUserRow | null> {
  const [row] = await db
    .update(botUsers)
    .set({
      oxyUserId: input.oxyUserId,
      isLinked: true,
      linkedAt: new Date(),
      authToken: null,
      authTokenExpiry: null,
      ...(input.sessionToken === undefined
        ? {}
        : {
            metadata: sql`${botUsers.metadata} || ${JSON.stringify({
              sessionToken: input.sessionToken,
            })}::jsonb`,
          }),
    })
    .where(eq(botUsers.id, id))
    .returning(BOT_USER_COLUMNS);

  return row ?? null;
}

/**
 * Unbind the Oxy account.
 *
 * `conversation_id` goes too, so the next message starts a fresh conversation
 * rather than continuing one the unlinked account owns.
 */
export async function unlinkBotUser(db: ApiDatabase, id: string): Promise<void> {
  await db
    .update(botUsers)
    .set({ oxyUserId: null, isLinked: false, conversationId: null, linkedAt: null })
    .where(eq(botUsers.id, id));
}

/** Log a bot user out: unbind, but keep `linked_at` as the historical record. */
export async function logoutBotUser(db: ApiDatabase, id: string): Promise<void> {
  await db
    .update(botUsers)
    .set({ oxyUserId: null, isLinked: false, conversationId: null })
    .where(eq(botUsers.id, id));
}

/** Mint a short-lived link token. */
export async function setBotUserAuthToken(
  db: ApiDatabase,
  id: string,
  authToken: string,
  expiry: Date,
): Promise<void> {
  await db
    .update(botUsers)
    .set({ authToken, authTokenExpiry: expiry })
    .where(eq(botUsers.id, id));
}

/** Point a bot user at a conversation. `null` detaches it. */
export async function setBotUserConversation(
  db: ApiDatabase,
  id: string,
  conversationId: string | null,
): Promise<void> {
  await db.update(botUsers).set({ conversationId }).where(eq(botUsers.id, id));
}

/** Record the model this person prefers. */
export async function setBotUserPreferredModel(
  db: ApiDatabase,
  id: string,
  preferredModel: string,
): Promise<void> {
  await db.update(botUsers).set({ preferredModel }).where(eq(botUsers.id, id));
}
