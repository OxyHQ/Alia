-- oxy:deploy-phase=pre
--
-- Additive only: eight new tables for notifications, delivery credentials and
-- the small independent tables that travel with them. Seven Mongoose models
-- become eight tables — `referral_redemptions` is a child table, see below.
-- Nothing existing is touched.
--
-- Two things here are deliberate DEPARTURES from the source, not oversights:
--
--   * `notifications.dismissed_at` exists because Mongo's TTL was CONDITIONAL
--     (90 days from `createdAt` where `status = 'dismissed'`) and the sweep
--     registry has no predicate. The condition became a column, bound to
--     `status` by `notifications_dismissed_at_check` so the two cannot drift.
--     This is MORE correct than the original: Mongo measured from creation, so a
--     notification dismissed on day 89 vanished the next day while one dismissed
--     on day 1 survived another 89. Dismissed notifications now last 90 days
--     from the dismissal. It is the one real behaviour change in the port.
--
--   * `referral_redemptions` is a child table with UNIQUE(referred_user_id),
--     where Mongo had a `referredUsers` sub-document array. That unique is a
--     money guard: routes/referrals.ts grants credits to BOTH parties and only
--     afterwards sets the redeemer's `referred_by`, so the "already redeemed?"
--     check is a read-then-write whose write lands after the payout. Two
--     concurrent redemptions both pass it and both pay. A `$push` into an array
--     cannot be made unique; a row can.
--
--     BACKFILL AUDIT ITEM: this is a tightening. An account appearing under two
--     referrers in production will be refused by the index — which is the bug
--     surfacing at the right moment, but expect it rather than discover it.
--
-- Mongo's TEXT index on `suggestions` is deliberately NOT ported: nothing in the
-- service issues a $text or $search query, so a tsvector column and GIN index
-- would be inventing a feature rather than migrating one.
--
CREATE TABLE "audio_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"audio_url" text,
	"error" text,
	"prompt" text NOT NULL,
	"duration" integer NOT NULL,
	"conversation_id" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "audio_jobs_status_check" CHECK ("audio_jobs"."status" in ('processing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"delivery_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"trigger_id" text,
	"conversation_id" text,
	"expires_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service')),
	CONSTRAINT "notifications_status_check" CHECK ("notifications"."status" in ('pending', 'sent', 'read', 'dismissed')),
	CONSTRAINT "notifications_priority_check" CHECK ("notifications"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "notifications_channels_check" CHECK ("notifications"."channels" <@ ARRAY['push', 'telegram', 'discord', 'whatsapp', 'slack', 'in_app']::text[]),
	CONSTRAINT "notifications_dismissed_at_check" CHECK (("notifications"."status" = 'dismissed') = ("notifications"."dismissed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"token" text NOT NULL,
	"device_id" text,
	"platform" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "push_tokens_platform_check" CHECK ("push_tokens"."platform" in ('ios', 'android', 'web'))
);
--> statement-breakpoint
CREATE TABLE "referral_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"referral_id" text NOT NULL,
	"referred_user_id" text NOT NULL,
	"email" text,
	"credited_at" timestamp with time zone NOT NULL,
	"credits_awarded" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" text PRIMARY KEY NOT NULL,
	"invite_code" text NOT NULL,
	"referred_by" text,
	"total_credits_earned" integer DEFAULT 0 NOT NULL,
	"total_referrals" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"topic" text NOT NULL,
	"format" text DEFAULT 'podcast' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audio_url" text,
	"duration_ms" integer,
	"error" text,
	"source_conversation_id" text,
	"source_notes" text,
	"credits_charged" integer,
	"progress" integer DEFAULT 0 NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shows_format_check" CHECK ("shows"."format" in ('podcast', 'news', 'debate', 'interview', 'explainer')),
	CONSTRAINT "shows_status_check" CHECK ("shows"."status" in ('queued', 'generating_script', 'generating_audio', 'concatenating', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"suggestion_id" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"description" text,
	"is_template" boolean DEFAULT false NOT NULL,
	"template_variables" text[] DEFAULT '{}'::text[] NOT NULL,
	"type" text NOT NULL,
	"category" text,
	"trigger_words" text[] DEFAULT '{}'::text[] NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"oxy_user_id" text,
	"language" text DEFAULT 'en-US' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"is_ai_generated" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"occupations" text[] DEFAULT '{}'::text[] NOT NULL,
	"interests" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "suggestions_type_check" CHECK ("suggestions"."type" in ('welcome', 'autocomplete')),
	CONSTRAINT "suggestions_scope_check" CHECK ("suggestions"."scope" in ('global', 'personal'))
);
--> statement-breakpoint
CREATE TABLE "web_push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"keys_p_256dh" text NOT NULL,
	"keys_auth" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referral_redemptions" ADD CONSTRAINT "referral_redemptions_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_jobs_user_id_idx" ON "audio_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audio_jobs_created_at_idx" ON "audio_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_oxy_user_status_created_idx" ON "notifications" USING btree ("oxy_user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("oxy_user_id","status") WHERE "notifications"."status" in ('pending', 'sent');--> statement-breakpoint
CREATE INDEX "notifications_dismissed_at_idx" ON "notifications" USING btree ("dismissed_at") WHERE "notifications"."dismissed_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_user_token_key" ON "push_tokens" USING btree ("oxy_user_id","token");--> statement-breakpoint
CREATE INDEX "push_tokens_token_idx" ON "push_tokens" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_redemptions_referred_user_key" ON "referral_redemptions" USING btree ("referred_user_id");--> statement-breakpoint
CREATE INDEX "referral_redemptions_referral_id_idx" ON "referral_redemptions" USING btree ("referral_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_invite_code_key" ON "referrals" USING btree ("invite_code");--> statement-breakpoint
CREATE INDEX "referrals_referred_by_idx" ON "referrals" USING btree ("referred_by") WHERE "referrals"."referred_by" is not null;--> statement-breakpoint
CREATE INDEX "shows_user_created_at_idx" ON "shows" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shows_user_status_idx" ON "shows" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_suggestion_id_key" ON "suggestions" USING btree ("suggestion_id");--> statement-breakpoint
CREATE INDEX "suggestions_scope_language_type_idx" ON "suggestions" USING btree ("scope","language","type");--> statement-breakpoint
CREATE INDEX "suggestions_user_scope_idx" ON "suggestions" USING btree ("oxy_user_id","scope");--> statement-breakpoint
CREATE INDEX "suggestions_trigger_words_idx" ON "suggestions" USING gin ("trigger_words");--> statement-breakpoint
CREATE INDEX "suggestions_expires_at_idx" ON "suggestions" USING btree ("expires_at") WHERE "suggestions"."expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "web_push_subscriptions_user_endpoint_key" ON "web_push_subscriptions" USING btree ("oxy_user_id","endpoint");