-- oxy:deploy-phase=pre
CREATE TABLE "memory_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"memory_key" text NOT NULL,
	"embedding" double precision[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"settings_auto_save_enabled" boolean DEFAULT true NOT NULL,
	"settings_recall_enabled" boolean DEFAULT true NOT NULL,
	"preferences_language" text,
	"preferences_tone" text,
	"preferences_response_length" text,
	"preferences_interests" text[] DEFAULT '{}'::text[] NOT NULL,
	"context_occupation" text,
	"context_location" text,
	"context_timezone" text,
	"context_bio" text,
	"writing_style" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_memories_preferences_response_length_check" CHECK ("user_memories"."preferences_response_length" in ('short', 'medium', 'long'))
);
--> statement-breakpoint
CREATE TABLE "user_memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_memory_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"type" text DEFAULT 'topic' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_memory_entries_type_check" CHECK ("user_memory_entries"."type" in ('profile', 'topic', 'person'))
);
--> statement-breakpoint
ALTER TABLE "user_memory_entries" ADD CONSTRAINT "user_memory_entries_user_memory_id_user_memories_id_fk" FOREIGN KEY ("user_memory_id") REFERENCES "public"."user_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_embeddings_oxy_user_memory_key_key" ON "memory_embeddings" USING btree ("oxy_user_id","memory_key");--> statement-breakpoint
CREATE UNIQUE INDEX "user_memories_oxy_user_id_key" ON "user_memories" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_memory_entries_memory_title_lower_key" ON "user_memory_entries" USING btree ("user_memory_id",lower(trim("title")));--> statement-breakpoint
CREATE INDEX "user_memory_entries_memory_type_idx" ON "user_memory_entries" USING btree ("user_memory_id","type");--> statement-breakpoint
CREATE INDEX "user_memory_entries_memory_updated_at_idx" ON "user_memory_entries" USING btree ("user_memory_id","updated_at" DESC NULLS LAST);