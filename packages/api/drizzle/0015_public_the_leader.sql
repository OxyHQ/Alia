-- oxy:deploy-phase=pre
CREATE TABLE "containers" (
	"id" text PRIMARY KEY NOT NULL,
	"container_id" text NOT NULL,
	"name" text NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"image" text NOT NULL,
	"size" text DEFAULT 'small' NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"persistent" boolean DEFAULT false NOT NULL,
	"preview_url" text,
	"exposed_ports" integer[] DEFAULT '{}' NOT NULL,
	"last_activity_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "containers_size_check" CHECK ("containers"."size" in ('small', 'medium', 'large')),
	CONSTRAINT "containers_status_check" CHECK ("containers"."status" in ('creating', 'running', 'idle', 'stopped', 'destroyed'))
);
--> statement-breakpoint
CREATE TABLE "event_stream_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"timestamp" bigint NOT NULL,
	"type" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "event_stream_entries_type_check" CHECK ("event_stream_entries"."type" in ('user_message', 'system_message', 'action', 'observation', 'error', 'plan_update', 'thinking', 'response', 'complete', 'screenshot', 'plan_progress', 'file_change', 'source_found', 'threat_detected'))
);
--> statement-breakpoint
ALTER TABLE "event_stream_entries" ADD CONSTRAINT "event_stream_entries_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "containers_container_id_idx" ON "containers" USING btree ("container_id");--> statement-breakpoint
CREATE INDEX "containers_session_id_idx" ON "containers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "containers_oxy_user_id_idx" ON "containers" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "containers_oxy_user_status_idx" ON "containers" USING btree ("oxy_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "event_stream_entries_session_seq_key" ON "event_stream_entries" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "event_stream_entries_session_archived_seq_idx" ON "event_stream_entries" USING btree ("session_id","archived","seq");--> statement-breakpoint
CREATE INDEX "event_stream_entries_session_type_timestamp_idx" ON "event_stream_entries" USING btree ("session_id","type","timestamp");