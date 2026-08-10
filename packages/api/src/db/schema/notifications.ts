/**
 * Notifications and their delivery credentials, plus the small independent
 * tables that travel with them: suggestions, shows and referrals.
 *
 * Seven Mongoose models become EIGHT tables — `referral_redemptions` is a child
 * table, for the reason given at `referrals`.
 *
 * ## `dismissed_at` is the conditional TTL made expressible, and it is MORE
 * correct than the original
 *
 * Mongo swept notifications with `{createdAt: 1}, expireAfterSeconds: 90d,
 * partialFilterExpression: {status: 'dismissed'}` — a CONDITIONAL delete
 * measured from the wrong column. `ExpirySweepTarget` has no predicate, so the
 * only entry its type permits would delete every notification older than 90 days
 * including undismissed ones.
 *
 * The answer decided in `db/expiryTargets.ts` and implemented here is to make the
 * CONDITION a COLUMN: `dismissed_at`, written only on dismissal, swept at 90 days
 * from IT, bound to `status` by a CHECK so the sweep cannot drift from the
 * condition it replaced. A notification never dismissed has NULL and is never
 * swept.
 *
 * **This is a real behaviour change and the only one in the port so far.** Mongo
 * measured from `created_at`, so a notification dismissed on day 89 vanished the
 * next day while one dismissed on day 1 survived another 89. Measuring from the
 * dismissal is the retention rule anyone would actually write down, and it means
 * a dismissed notification now reliably lasts 90 days from dismissal rather than
 * however much of its first 90 days happened to remain.
 */

import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkArrayWithin, checkOneOf } from './columns';

export const NOTIFICATION_TYPES = [
  'trigger_result',
  'proactive_insight',
  'daily_briefing',
  'price_alert',
  'integration_event',
  'reminder',
  'agent_task_complete',
  'chat_response_ready',
  'oxy_service',
] as const;
export type NotificationTypeValue = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['push', 'telegram', 'discord', 'whatsapp', 'slack', 'in_app'] as const;
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'read', 'dismissed'] as const;
export const NOTIFICATION_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const PUSH_TOKEN_PLATFORMS = ['ios', 'android', 'web'] as const;
export const SUGGESTION_TYPES = ['welcome', 'autocomplete'] as const;
export const SUGGESTION_SCOPES = ['global', 'personal'] as const;
export const SHOW_FORMATS = ['podcast', 'news', 'debate', 'interview', 'explainer'] as const;
export const SHOW_STATUSES = [
  'queued',
  'generating_script',
  'generating_audio',
  'concatenating',
  'completed',
  'failed',
] as const;
export const AUDIO_JOB_STATUSES = ['processing', 'completed', 'failed'] as const;

/**
 * One notification.
 *
 * **All nine `type` values are kept**, including the five with no producer today
 * (`proactive_insight`, `daily_briefing`, `price_alert`, `integration_event`,
 * `reminder`). Four ARE produced — `agent_task_complete`, `trigger_result`,
 * `oxy_service`, `chat_response_ready` — so a narrowing of this tuple is a `post`
 * migration somebody takes deliberately against a census, not a tidy-up. Note
 * `integration_event` reads as produced on a naive grep because it is also a
 * TRIGGER type; that false positive is exactly why the narrowing needs the
 * census rather than a search.
 *
 * `expires_at` is DEAD PLUMBING and kept as a faithful port:
 * `SendNotificationOptions` declares it and `notification-service.ts` writes it
 * through, and no caller anywhere passes one. `trigger_id` is NOT dead — the
 * service converts and stores it — and carries no foreign key, because a
 * notification is a record shown to a person and must outlive the trigger that
 * produced it.
 *
 * `delivery_status` is `jsonb`: a per-channel map whose keys are the channels
 * actually attempted, read whole when the notification is rendered.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    type: text({ enum: NOTIFICATION_TYPES as unknown as [string, ...string[]] }).notNull(),
    title: text().notNull(),
    body: text().notNull(),
    data: jsonb(),
    channels: text().array().notNull().default(sql`'{}'::text[]`),
    deliveryStatus: jsonb().notNull().default({}),
    status: text({ enum: NOTIFICATION_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('pending'),
    priority: text({ enum: NOTIFICATION_PRIORITIES as unknown as [string, ...string[]] })
      .notNull()
      .default('normal'),
    /** A `triggers` row. No foreign key — see the table comment. */
    triggerId: text(),
    conversationId: text(),
    /** Declared and written through, never supplied by a caller. */
    expiresAt: timestamptz(),
    readAt: timestamptz(),
    /**
     * Written ONLY on dismissal, and the sweep measures 90 days from here. The
     * CHECK below is what stops it drifting from the status it stands for.
     */
    dismissedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('notifications_oxy_user_status_created_idx').on(t.oxyUserId, t.status, t.createdAt.desc()),
    /**
     * The unread-count index, partial exactly as Mongo declared it. This one IS
     * a faithful copy of a `partialFilterExpression` — unlike the TTL, a partial
     * INDEX ports directly.
     */
    index('notifications_unread_idx')
      .on(t.oxyUserId, t.status)
      .where(sql`${t.status} in ('pending', 'sent')`),
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('notifications_dismissed_at_idx')
      .on(t.dismissedAt)
      .where(sql`${t.dismissedAt} is not null`),
    checkOneOf('notifications_type_check', t.type, NOTIFICATION_TYPES),
    checkOneOf('notifications_status_check', t.status, NOTIFICATION_STATUSES),
    checkOneOf('notifications_priority_check', t.priority, NOTIFICATION_PRIORITIES),
    checkArrayWithin('notifications_channels_check', t.channels, NOTIFICATION_CHANNELS),
    /**
     * `dismissed_at` is set exactly when the status is `dismissed`. Without this
     * the sweep's column and the condition it replaced could disagree, and the
     * failure would be silent in the worst direction: rows deleted that were
     * never dismissed, or dismissed rows kept forever.
     */
    check(
      'notifications_dismissed_at_check',
      sql`(${t.status} = 'dismissed') = (${t.dismissedAt} is not null)`,
    ),
  ],
);

/**
 * A device push token.
 *
 * `token` is a credential AND a lookup key — `notification-service` finds a row
 * by it to handle a `DeviceNotRegistered` receipt — so it is plaintext and
 * indexed, per the rule the bot and trigger webhook secrets established.
 */
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    token: text().notNull(),
    deviceId: text(),
    platform: text({ enum: PUSH_TOKEN_PLATFORMS as unknown as [string, ...string[]] }),
    active: boolean().notNull().default(true),
    lastUsedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('push_tokens_user_token_key').on(t.oxyUserId, t.token),
    index('push_tokens_token_idx').on(t.token),
    checkOneOf('push_tokens_platform_check', t.platform, PUSH_TOKEN_PLATFORMS),
  ],
);

/**
 * A browser push subscription.
 *
 * `keys_p256dh` and `keys_auth` are the subscription's encryption keys — a
 * credential pair, flattened from the nested `keys` sub-document. Not encrypted
 * in Mongo and not encrypted here (a faithful port), but they belong out of
 * every response and every log line.
 */
export const webPushSubscriptions = pgTable(
  'web_push_subscriptions',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    endpoint: text().notNull(),
    /** Credentials. See the table comment. */
    keysP256dh: text().notNull(),
    keysAuth: text().notNull(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('web_push_subscriptions_user_endpoint_key').on(t.oxyUserId, t.endpoint)],
);

/**
 * A prompt suggestion.
 *
 * **Mongo's TEXT index is deliberately NOT ported.** `{text: 'text', title:
 * 'text'}` exists on the model and nothing queries it — there is no `$text` or
 * `$search` anywhere in the service. Porting it would mean adding a `tsvector`
 * column and a GIN index to support a search nobody performs, which is inventing
 * a feature rather than migrating one. If full-text search is wanted later it is
 * an additive migration.
 *
 * `template_variables` and `is_template` are DERIVED from `text` by a
 * `pre('save')` hook. Verdict: case 2 — it needs a regex extraction no CHECK can
 * express, so it must be re-expressed at the single write chokepoint when the
 * repository lands. Worth knowing before that happens: the hook runs on `create`
 * and `save` but NOT on `routes/suggestions.ts:560`'s `updateOne` or
 * `seed-suggestions.ts:451`'s `findOneAndUpdate`, so these two columns are
 * already stale on those paths today. The port neither introduces nor fixes
 * that; re-expressing it at the chokepoint would fix it, which is a change worth
 * making deliberately rather than as a side effect.
 */
export const suggestions = pgTable(
  'suggestions',
  {
    id: generatedId(),
    suggestionId: text().notNull(),
    title: text().notNull(),
    text: text().notNull(),
    description: text(),
    isTemplate: boolean().notNull().default(false),
    templateVariables: text().array().notNull().default(sql`'{}'::text[]`),
    type: text({ enum: SUGGESTION_TYPES as unknown as [string, ...string[]] }).notNull(),
    category: text(),
    triggerWords: text().array().notNull().default(sql`'{}'::text[]`),
    scope: text({ enum: SUGGESTION_SCOPES as unknown as [string, ...string[]] })
      .notNull()
      .default('global'),
    /** An Oxy account, for a `personal` suggestion. No foreign key. */
    oxyUserId: text(),
    language: text().notNull().default('en-US'),
    usageCount: integer().notNull().default(0),
    priority: integer().notNull().default(0),
    isBuiltIn: boolean().notNull().default(false),
    isAiGenerated: boolean('is_ai_generated').notNull().default(false),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    occupations: text().array().notNull().default(sql`'{}'::text[]`),
    interests: text().array().notNull().default(sql`'{}'::text[]`),
    /** A publication deadline the READ filters on. NOT a sweep target — Mongo declared no TTL. */
    expiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('suggestions_suggestion_id_key').on(t.suggestionId),
    index('suggestions_scope_language_type_idx').on(t.scope, t.language, t.type),
    index('suggestions_user_scope_idx').on(t.oxyUserId, t.scope),
    index('suggestions_trigger_words_idx').using('gin', t.triggerWords),
    index('suggestions_expires_at_idx').on(t.expiresAt).where(sql`${t.expiresAt} is not null`),
    checkOneOf('suggestions_type_check', t.type, SUGGESTION_TYPES),
    checkOneOf('suggestions_scope_check', t.scope, SUGGESTION_SCOPES),
  ],
);

/**
 * A generated audio show.
 *
 * `speakers` and `segments` are `jsonb`: ordered lists read whole when the show
 * is generated or played back, with no cross-table reference and no per-element
 * toggle. A segment's `speaker` names a speaker's `name` WITHIN the same
 * document, which is the `workflows.edges` situation — an internal reference a
 * child table could not make checkable either.
 */
export const shows = pgTable(
  'shows',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    userId: text().notNull(),
    title: text().notNull(),
    description: text(),
    topic: text().notNull(),
    format: text({ enum: SHOW_FORMATS as unknown as [string, ...string[]] })
      .notNull()
      .default('podcast'),
    status: text({ enum: SHOW_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('queued'),
    speakers: jsonb().notNull().default([]),
    segments: jsonb().notNull().default([]),
    audioUrl: text(),
    durationMs: integer(),
    error: text(),
    sourceConversationId: text(),
    sourceNotes: text(),
    /** A count of AI credits, not money. */
    creditsCharged: integer(),
    progress: integer().notNull().default(0),
    jobId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('shows_user_created_at_idx').on(t.userId, t.createdAt.desc()),
    index('shows_user_status_idx').on(t.userId, t.status),
    checkOneOf('shows_format_check', t.format, SHOW_FORMATS),
    checkOneOf('shows_status_check', t.status, SHOW_STATUSES),
  ],
);

/**
 * One account's referral record.
 *
 * **`id` is an OXY ACCOUNT ID with no default**, the second table after
 * `user_credits` where `generatedId()` would be actively wrong: Mongo declared
 * `_id: { type: String }` and wrote the account id into it.
 *
 * `total_credits_earned` and `total_referrals` are counters Mongo maintained with
 * `$inc`. They are kept as stored columns (a faithful port) and are now
 * DERIVABLE from `referral_redemptions`, so a repair is possible where it was not
 * before. Never sum the two sources together.
 */
export const referrals = pgTable(
  'referrals',
  {
    /** The Oxy account id. No default, no foreign key. */
    id: text().primaryKey(),
    inviteCode: text().notNull(),
    /** The Oxy account that referred this one. Set exactly once. */
    referredBy: text(),
    totalCreditsEarned: integer().notNull().default(0),
    totalReferrals: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('referrals_invite_code_key').on(t.inviteCode),
    index('referrals_referred_by_idx').on(t.referredBy).where(sql`${t.referredBy} is not null`),
  ],
);

/**
 * One redemption: who was referred by whom, and what it paid.
 *
 * **A child table rather than the `jsonb` its Mongoose sub-document array
 * suggests, and the reason is a money race.**
 *
 * `routes/referrals.ts` grants credits to BOTH parties and only afterwards sets
 * the redeemer's `referred_by` — so the "have you already redeemed?" guard is a
 * read-then-write whose write lands after the money moves. Two concurrent
 * redemptions by one account both pass the check and both pay out, and Mongo had
 * no constraint that could stop it: a `$push` into an array cannot be made
 * unique.
 *
 * `UNIQUE(referred_user_id)` makes it structural — an account can be referred at
 * most once, globally, which is the rule the credit grant already assumes. It is
 * the `transactions.dedup_key` shape: a guarantee the money path depends on,
 * which existed nowhere the database could enforce it.
 *
 * **Backfill audit item:** this is a TIGHTENING. If production holds an account
 * appearing under two referrers, the index will refuse it — which is the bug
 * surfacing at the right moment, but it must be expected rather than discovered
 * during a cutover.
 */
export const referralRedemptions = pgTable(
  'referral_redemptions',
  {
    id: generatedId(),
    referralId: text()
      .notNull()
      .references(() => referrals.id, { onDelete: 'cascade' }),
    /** The Oxy account that redeemed. No foreign key; Oxy owns identity. */
    referredUserId: text().notNull(),
    email: text(),
    creditedAt: timestamptz().notNull(),
    /** A count of AI credits, not money. */
    creditsAwarded: integer().notNull(),
  },
  (t) => [
    uniqueIndex('referral_redemptions_referred_user_key').on(t.referredUserId),
    index('referral_redemptions_referral_id_idx').on(t.referralId),
  ],
);

/**
 * An audio generation job.
 *
 * TTL: 24 hours from `created_at` — the shortest in the schema, and right,
 * because a job is ephemeral and its output URL is stored on whatever consumed
 * it.
 *
 * `cleanupOrphanedJobs` reads `modifiedCount` on an `updateMany` whose filter
 * (`status = 'processing'` older than five minutes) already excludes rows that
 * would not change, so `rowCount` is a faithful port of that count — the
 * narrowed-filter case from CONVENTIONS.md, not the `/health/reset-all` one.
 */
export const audioJobs = pgTable(
  'audio_jobs',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    userId: text().notNull(),
    status: text({ enum: AUDIO_JOB_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('processing'),
    audioUrl: text(),
    error: text(),
    prompt: text().notNull(),
    durationSeconds: integer('duration').notNull(),
    conversationId: text(),
    messageId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('audio_jobs_user_id_idx').on(t.userId),
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('audio_jobs_created_at_idx').on(t.createdAt),
    checkOneOf('audio_jobs_status_check', t.status, AUDIO_JOB_STATUSES),
  ],
);
