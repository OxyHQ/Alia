-- oxy:deploy-phase=pre
-- Additive: five new tables, nullable Oxy file columns, two NOT NULLs relaxed
-- (a row may now name an Oxy file instead of a legacy key) and the skill_files
-- storage CHECK widened to admit an Oxy file. Every row the previous image
-- writes satisfies every constraint here. See docs/oxy-files.md.
CREATE TABLE "legacy_storage_reads" (
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"reads" bigint DEFAULT 0 NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_storage_reads_pkey" PRIMARY KEY("kind","day"),
	CONSTRAINT "legacy_storage_reads_kind_check" CHECK ("legacy_storage_reads"."kind" in ('library_file', 'speech_clip', 'skill_file', 'audio_job', 'other'))
);
--> statement-breakpoint
CREATE TABLE "oxy_file_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reconcile_runs" (
	"entity_type" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_result" jsonb,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reconcile_runs_entity_type_check" CHECK ("oxy_file_reconcile_runs"."entity_type" in ('show_series', 'library_file', 'speech_clip', 'skill_file'))
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reference_sync" (
	"file_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"desired" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reference_sync_pkey" PRIMARY KEY("file_id","entity_type","entity_id"),
	CONSTRAINT "oxy_file_reference_sync_entity_type_check" CHECK ("oxy_file_reference_sync"."entity_type" in ('show_series', 'library_file', 'speech_clip', 'skill_file')),
	CONSTRAINT "oxy_file_reference_sync_desired_check" CHECK ("oxy_file_reference_sync"."desired" in ('present', 'absent')),
	CONSTRAINT "oxy_file_reference_sync_status_check" CHECK ("oxy_file_reference_sync"."status" in ('pending', 'dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "storage_gc_candidates" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "storage_gc_candidates_kind_check" CHECK ("storage_gc_candidates"."kind" in ('library_file', 'speech_clip', 'skill_file'))
);
--> statement-breakpoint
ALTER TABLE "skill_files" DROP CONSTRAINT "skill_files_storage_check";--> statement-breakpoint
ALTER TABLE "library_files" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "speech_clips" ALTER COLUMN "object_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "library_files" ADD COLUMN "oxy_file_id" text;--> statement-breakpoint
ALTER TABLE "show_series" ADD COLUMN "cover_file_id" text;--> statement-breakpoint
ALTER TABLE "skill_files" ADD COLUMN "oxy_file_id" text;--> statement-breakpoint
ALTER TABLE "speech_clips" ADD COLUMN "oxy_file_id" text;--> statement-breakpoint
CREATE INDEX "oxy_file_events_created_at_idx" ON "oxy_file_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "oxy_file_reference_sync_claim_idx" ON "oxy_file_reference_sync" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "storage_gc_candidates_not_before_idx" ON "storage_gc_candidates" USING btree ("not_before");--> statement-breakpoint
CREATE INDEX "library_files_oxy_file_id_idx" ON "library_files" USING btree ("oxy_file_id");--> statement-breakpoint
CREATE INDEX "show_series_cover_file_id_idx" ON "show_series" USING btree ("cover_file_id");--> statement-breakpoint
CREATE INDEX "skill_files_s3_key_idx" ON "skill_files" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX "skill_files_oxy_file_id_idx" ON "skill_files" USING btree ("oxy_file_id");--> statement-breakpoint
CREATE INDEX "speech_clips_oxy_file_id_idx" ON "speech_clips" USING btree ("oxy_file_id");--> statement-breakpoint
ALTER TABLE "library_files" ADD CONSTRAINT "library_files_storage_check" CHECK ("library_files"."url" is not null or "library_files"."oxy_file_id" is not null);--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_storage_check" CHECK (("skill_files"."content_text" is null) <> ("skill_files"."s3_key" is null and "skill_files"."oxy_file_id" is null));--> statement-breakpoint
ALTER TABLE "speech_clips" ADD CONSTRAINT "speech_clips_storage_check" CHECK ("speech_clips"."object_key" is not null or "speech_clips"."oxy_file_id" is not null);