-- oxy:deploy-phase=pre
--
-- Additive only: four new tables, nothing existing altered or dropped. The
-- serving image reads and writes none of them.
--
-- cache_stats carries a CHECK pinning its id to the single value 'global'. Mongo
-- enforced the singleton by everybody defaulting `_id` to the same string; here a
-- second row is unrepresentable, so a stray insert cannot split the counters and
-- leave every read showing whichever half it found.

CREATE TABLE "cache_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"model" text NOT NULL,
	"messages" jsonb NOT NULL,
	"response" jsonb NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_saved" double precision DEFAULT 0 NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cache_stats" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"total_hits" bigint DEFAULT 0 NOT NULL,
	"total_misses" bigint DEFAULT 0 NOT NULL,
	"total_cost_saved" double precision DEFAULT 0 NOT NULL,
	"total_tokens_saved" bigint DEFAULT 0 NOT NULL,
	"last_reset" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "cache_stats_singleton_check" CHECK ("cache_stats"."id" in ('global'))
);
--> statement-breakpoint
CREATE TABLE "chat_analytics" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"platform" text DEFAULT 'app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"alias_model_id" text NOT NULL,
	"actual_provider" text NOT NULL,
	"actual_model_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	"saved_from_cache" boolean DEFAULT false NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cache_entries_key_key" ON "cache_entries" USING btree ("key");--> statement-breakpoint
CREATE INDEX "cache_entries_prompt_hash_idx" ON "cache_entries" USING btree ("prompt_hash");--> statement-breakpoint
CREATE INDEX "cache_entries_model_idx" ON "cache_entries" USING btree ("model");--> statement-breakpoint
CREATE INDEX "cache_entries_expires_at_idx" ON "cache_entries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cache_entries_created_at_idx" ON "cache_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chat_analytics_oxy_user_created_at_idx" ON "chat_analytics" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cost_entries_user_timestamp_idx" ON "cost_entries" USING btree ("user_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cost_entries_alias_model_timestamp_idx" ON "cost_entries" USING btree ("alias_model_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cost_entries_user_alias_model_idx" ON "cost_entries" USING btree ("user_id","alias_model_id");--> statement-breakpoint
CREATE INDEX "cost_entries_session_id_idx" ON "cost_entries" USING btree ("session_id");