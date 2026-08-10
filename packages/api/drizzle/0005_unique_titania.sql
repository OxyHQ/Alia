-- oxy:deploy-phase=pre
--
-- Additive only: four new tables for platform bots and the Oxy service
-- connector. Nothing existing is touched. The serving image writes all four
-- collections in Mongo and reads none of these tables.
--
-- The one thing here that must not be "made consistent":
--
--   `bots.bot_token` is encrypted application-side (the `encryptedText` custom
--   type) and `bots.webhook_secret` is PLAINTEXT, even though both were
--   `select: false` credentials in Mongoose. That asymmetry is load-bearing.
--   `routes/webhooks.ts` finds a bot with `Bot.findOne({ webhookSecret: ... })`
--   on every inbound update, so the column is a LOOKUP KEY; the codec is AES-GCM
--   with a random IV, so the same plaintext encrypts differently every time and
--   an equality lookup can never match. Encrypting it does not weaken routing —
--   it breaks it completely, silently, as a 404 on every inbound message.
--
--   If that lookup ever has to go away, the replacement is a deterministic keyed
--   digest stored beside the secret, not encryption of the secret itself.
--
-- `oxy_services.webhook_secret` is a different case and is also plaintext: it is
-- a verification key read AFTER the row is found by `service_id`, and it was not
-- `select: false`, so encrypting it would be a change of posture rather than a
-- faithful port.
--
CREATE TABLE "bot_users" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"platform" text NOT NULL,
	"platform_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"oxy_user_id" text,
	"is_linked" boolean DEFAULT false NOT NULL,
	"linked_at" timestamp with time zone,
	"username" text,
	"display_name" text,
	"auth_token" text,
	"auth_token_expiry" timestamp with time zone,
	"auth_token_mode" text,
	"conversation_id" text,
	"preferred_model" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "bot_users_auth_token_mode_check" CHECK ("bot_users"."auth_token_mode" in ('link', 'signin'))
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"bot_id" text NOT NULL,
	"name" text NOT NULL,
	"username" text,
	"avatar_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"user_id" text,
	"bot_token" text,
	"webhook_secret" text,
	"agent_id" text,
	"default_model" text,
	"platform_config_webhook_url" text,
	"platform_config_public_key" text,
	"total_users" integer DEFAULT 0 NOT NULL,
	"total_messages" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "bots_status_check" CHECK ("bots"."status" in ('active', 'inactive', 'error'))
);
--> statement-breakpoint
CREATE TABLE "oxy_service_event_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_name" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"payload_hash" text,
	"agent_session_id" text,
	"error_message" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_service_event_logs_action_check" CHECK ("oxy_service_event_logs"."action" in ('notify', 'context', 'autonomous')),
	CONSTRAINT "oxy_service_event_logs_status_check" CHECK ("oxy_service_event_logs"."status" in ('received', 'processed', 'failed', 'duplicate')),
	CONSTRAINT "oxy_service_event_logs_processed_pair_check" CHECK ("oxy_service_event_logs"."status" <> 'processed' or "oxy_service_event_logs"."processed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "oxy_services" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"version" text NOT NULL,
	"base_url" text NOT NULL,
	"icon" text,
	"status" text DEFAULT 'active' NOT NULL,
	"is_first_party" boolean DEFAULT false NOT NULL,
	"webhook_secret" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_endpoint" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_services_status_check" CHECK ("oxy_services"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "bot_users" ADD CONSTRAINT "bot_users_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_users_bot_platform_user_key" ON "bot_users" USING btree ("bot_id","platform_user_id");--> statement-breakpoint
CREATE INDEX "bot_users_auth_token_idx" ON "bot_users" USING btree ("auth_token","auth_token_expiry") WHERE "bot_users"."auth_token" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_platform_bot_id_key" ON "bots" USING btree ("platform","bot_id");--> statement-breakpoint
CREATE INDEX "bots_webhook_secret_idx" ON "bots" USING btree ("webhook_secret") WHERE "bots"."webhook_secret" is not null;--> statement-breakpoint
CREATE INDEX "bots_user_id_idx" ON "bots" USING btree ("user_id") WHERE "bots"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_service_event_logs_service_user_event_key" ON "oxy_service_event_logs" USING btree ("service_id","oxy_user_id","event_id");--> statement-breakpoint
CREATE INDEX "oxy_service_event_logs_service_id_idx" ON "oxy_service_event_logs" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "oxy_service_event_logs_oxy_user_created_at_idx" ON "oxy_service_event_logs" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "oxy_service_event_logs_status_idx" ON "oxy_service_event_logs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_services_service_id_key" ON "oxy_services" USING btree ("service_id");