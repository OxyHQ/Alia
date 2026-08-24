-- oxy:deploy-phase=pre
-- A show becomes a SERIES of episodes, published to Syra.
--
-- Additive and entirely new: three tables that nothing reads yet. `pre`,
-- because the image that follows this migration is the first thing able to
-- write them, and an image rolling out ahead of its own tables has nowhere to
-- put a series.
--
-- The DROP of the old `shows` table is a SEPARATE migration on purpose. A file
-- carries exactly one deploy-phase marker, so a single migration holding both
-- these creates and that drop could only be one phase, and BOTH readings are
-- wrong: `pre` would destroy the old table while the old image is still
-- serving it, `post` would withhold these tables until after the new image is
-- already trying to use them. See 0034.
CREATE TABLE "show_episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"series_id" text NOT NULL,
	"episode_number" integer NOT NULL,
	"title" text NOT NULL,
	"topic" text NOT NULL,
	"notes" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"job_id" text,
	"credits_charged" integer,
	"syra_episode_id" text,
	"ingest_ticket" text,
	"ingest_ticket_expires_at" timestamp with time zone,
	"recap" text,
	"duration_ms" integer,
	"source_conversation_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "show_episodes_status_check" CHECK ("show_episodes"."status" in ('queued', 'generating_script', 'generating_audio', 'concatenating', 'publishing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "show_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"default_visibility" text DEFAULT 'private' NOT NULL,
	"default_format" text DEFAULT 'podcast' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "show_preferences_visibility_check" CHECK ("show_preferences"."default_visibility" in ('private', 'unlisted', 'public')),
	CONSTRAINT "show_preferences_format_check" CHECK ("show_preferences"."default_format" in ('podcast', 'news', 'debate', 'interview', 'explainer'))
);
--> statement-breakpoint
CREATE TABLE "show_series" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"syra_podcast_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"format" text DEFAULT 'podcast' NOT NULL,
	"brief" text NOT NULL,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"cover_image_asset_id" text,
	"next_episode_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "show_series_format_check" CHECK ("show_series"."format" in ('podcast', 'news', 'debate', 'interview', 'explainer')),
	CONSTRAINT "show_series_visibility_check" CHECK ("show_series"."visibility" in ('private', 'unlisted', 'public'))
);
--> statement-breakpoint
ALTER TABLE "show_episodes" ADD CONSTRAINT "show_episodes_series_id_show_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."show_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "show_episodes_user_status_idx" ON "show_episodes" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "show_episodes_series_number_idx" ON "show_episodes" USING btree ("series_id","episode_number" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "show_episodes_series_number_key" ON "show_episodes" USING btree ("series_id","episode_number");--> statement-breakpoint
CREATE INDEX "show_series_user_created_at_idx" ON "show_series" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "show_series_syra_podcast_id_key" ON "show_series" USING btree ("syra_podcast_id");