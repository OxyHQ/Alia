/**
 * Platform bots (Telegram and friends) and the people who talk to them.
 *
 * ## Two secrets on one table, and only ONE of them may be encrypted
 *
 * `bots.bot_token` and `bots.webhook_secret` are both credentials and both were
 * `select: false` in Mongoose. They get opposite treatment, and the difference is
 * not a judgement call:
 *
 *  - **`bot_token` is `encryptedText`.** It was `set: encrypt, get: decrypt` in
 *    Mongo, it is only ever read to call the platform, and nothing looks a row up
 *    by it. This is the codec's second customer after `integrations`.
 *  - **`webhook_secret` stays PLAINTEXT and indexed.** `routes/webhooks.ts` does
 *    `Bot.findOne({ webhookSecret: perBotSecret, … })` on every inbound update —
 *    it is a LOOKUP KEY. `encryptedText` is AES-GCM with a random IV, so the same
 *    plaintext encrypts to a different value every time (pinned by
 *    `integrations.pgdb.test.ts`), and an equality lookup against it can never
 *    match. Encrypting this column does not weaken security slightly; it breaks
 *    inbound bot routing completely, and the failure is a silent 404 on every
 *    message rather than an error at write time.
 *
 * If that lookup ever has to go, the replacement is a deterministic keyed digest
 * stored beside the secret — not encryption of the secret itself.
 *
 * ## `select: false` has no Postgres counterpart
 *
 * Mongoose omitted both columns from every query that did not ask for them, which
 * is why the one caller that needs them says `.select('+botToken +webhookSecret')`.
 * drizzle has no projection default: a bare `select()` returns them. The rule is
 * the one `provider_keys.key` already states — name columns, and leave these out
 * of every projection but the call that must use them. It is the setter rule's
 * sibling: a Mongoose default that held by construction and now holds only by
 * discipline.
 */

import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf, encryptedText } from './columns';

export const BOT_STATUSES = ['active', 'inactive', 'error'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

/** Whether a pending bot auth token links an existing account or signs one in. */
export const BOT_USER_AUTH_TOKEN_MODES = ['link', 'signin'] as const;
export type BotUserAuthTokenMode = (typeof BOT_USER_AUTH_TOKEN_MODES)[number];

/**
 * A bot registered against a messaging platform.
 *
 * `user_id` absent means the system/global bot configured from the environment
 * rather than one a person registered — which is why the webhook lookup above
 * additionally filters `userId: { $exists: true }`.
 *
 * `platform` has no CHECK: the value comes from the channel registry, a runtime
 * list this schema does not own.
 */
export const bots = pgTable(
  'bots',
  {
    id: generatedId(),
    platform: text().notNull(),
    /** The platform's own id for the bot, not Alia's. */
    botId: text().notNull(),
    name: text().notNull(),
    username: text(),
    avatarUrl: text(),
    status: text({ enum: BOT_STATUSES as unknown as [string, ...string[]] })
      .$type<BotStatus>()
      .notNull()
      .default('active'),
    /** An Oxy account. No foreign key. Absent for the global env-configured bot. */
    userId: text(),
    /** Encrypted at rest. Never select into a response. See the table comment. */
    botToken: encryptedText(),
    /**
     * PLAINTEXT and indexed, deliberately — it is the key inbound webhooks are
     * matched on. Encrypting it would break routing outright. Still a credential:
     * never log it, never select it into a response.
     */
    webhookSecret: text(),
    /** An `agents` row. No foreign key — that table is batch 9. */
    agentId: text(),
    defaultModel: text(),
    platformConfigWebhookUrl: text(),
    platformConfigPublicKey: text(),
    totalUsers: integer().notNull().default(0),
    totalMessages: integer().notNull().default(0),
    lastMessageAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bots_platform_bot_id_key').on(t.platform, t.botId),
    // The inbound-webhook lookup. Partial, the equivalent of Mongo's `sparse`.
    index('bots_webhook_secret_idx').on(t.webhookSecret).where(sql`${t.webhookSecret} is not null`),
    index('bots_user_id_idx').on(t.userId).where(sql`${t.userId} is not null`),
    checkOneOf('bots_status_check', t.status, BOT_STATUSES),
  ],
);

/**
 * One person's relationship with one bot.
 *
 * `auth_token` is a short-lived linking credential and is PLAINTEXT for the same
 * structural reason as `bots.webhook_secret`: the redemption path looks a row up
 * by it, paired with its expiry. It was NOT `select: false` in Mongoose, so this
 * port adds no projection guarantee it did not have — but it is still a
 * credential and belongs out of every response.
 *
 * There is deliberately no expiry SWEEP for it. `auth_token_expiry` bounds
 * whether the token WORKS, and Mongo declared no TTL index here, so adding one
 * would delete rows the source kept — a `bot_users` row outlives its auth token
 * and carries the link itself.
 */
export const botUsers = pgTable(
  'bot_users',
  {
    id: generatedId(),
    botId: text()
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    platform: text().notNull(),
    /** The platform's id for the person, not Alia's and not Oxy's. */
    platformUserId: text().notNull(),
    chatId: text().notNull(),
    /** An Oxy account, once linked. No foreign key. */
    oxyUserId: text(),
    isLinked: boolean().notNull().default(false),
    linkedAt: timestamptz(),
    username: text(),
    displayName: text(),
    /** A short-lived credential, looked up by. See the table comment. */
    authToken: text(),
    authTokenExpiry: timestamptz(),
    authTokenMode: text({
      enum: BOT_USER_AUTH_TOKEN_MODES as unknown as [string, ...string[]],
    }).$type<BotUserAuthTokenMode>(),
    conversationId: text(),
    preferredModel: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bot_users_bot_platform_user_key').on(t.botId, t.platformUserId),
    // The redemption lookup: the token and its deadline together.
    index('bot_users_auth_token_idx')
      .on(t.authToken, t.authTokenExpiry)
      .where(sql`${t.authToken} is not null`),
    checkOneOf('bot_users_auth_token_mode_check', t.authTokenMode, BOT_USER_AUTH_TOKEN_MODES),
  ],
);
