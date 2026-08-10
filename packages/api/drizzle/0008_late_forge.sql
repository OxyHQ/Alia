-- oxy:deploy-phase=pre
CREATE TABLE "library_files" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"type" text NOT NULL,
	"size" bigint NOT NULL,
	"category" text NOT NULL,
	"thumbnail" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "library_files_category_check" CHECK ("library_files"."category" in ('documents', 'images', 'other'))
);
--> statement-breakpoint
CREATE TABLE "voice_call_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"alia_model_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_model" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"duration_minutes" double precision DEFAULT 0 NOT NULL,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"cost_per_minute" double precision NOT NULL,
	"average_latency_ms" double precision,
	"disconnect_reason" text,
	"audio_format" text DEFAULT 'pcm16' NOT NULL,
	"sample_rate" integer DEFAULT 24000 NOT NULL,
	"client_type" text,
	"cohost_enabled" boolean DEFAULT false NOT NULL,
	"cohost_provider" text,
	"cohost_provider_model" text,
	"cohost_duration_minutes" double precision DEFAULT 0 NOT NULL,
	"cohost_credits_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "library_files_owner_created_at_idx" ON "library_files" USING btree ("owner_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "voice_call_usage_session_id_key" ON "voice_call_usage" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "voice_call_usage_oxy_user_start_time_idx" ON "voice_call_usage" USING btree ("oxy_user_id","start_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "voice_call_usage_provider_start_time_idx" ON "voice_call_usage" USING btree ("provider","start_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "voice_call_usage_alia_model_start_time_idx" ON "voice_call_usage" USING btree ("alia_model_id","start_time" DESC NULLS LAST);