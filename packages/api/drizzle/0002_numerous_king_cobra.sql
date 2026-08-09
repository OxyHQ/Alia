-- oxy:deploy-phase=pre
--
-- Additive only: four new moderation tables, nothing existing altered. The
-- serving image still writes these collections in Mongo and reads none of these
-- tables.
--
-- reports.categories carries TWO constraints, not one. `<@` is containment
-- (every member drawn from the tuple) and is TRUE for an EMPTY array, so the
-- cardinality rule is separate. It uses `cardinality()` and NOT
-- `array_length(col, 1)`: the latter returns NULL on an empty array, `NULL >= 1`
-- is NULL, and a CHECK rejects only FALSE — so the obvious spelling admits
-- exactly the value it exists to forbid. Mongoose expressed cardinality as a
-- custom validator, which did not run on updateOne at all.

CREATE TABLE "moderation_enforcements" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"decision_revision" integer NOT NULL,
	"action" text NOT NULL,
	"case_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"outcome" text NOT NULL,
	"recommended_action" text,
	"reason" text NOT NULL,
	"mode" text NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone,
	"skipped_reason" text,
	"previous_state" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_enforcements_action_check" CHECK ("moderation_enforcements"."action" in ('restrict', 'restore', 'demote', 'manual_review', 'none')),
	CONSTRAINT "moderation_enforcements_mode_check" CHECK ("moderation_enforcements"."mode" in ('observe', 'manual', 'automatic'))
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text,
	"case_id" text,
	"payload" jsonb,
	"state" text DEFAULT 'claimed' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"queued_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_events_state_check" CHECK ("moderation_events"."state" in ('claimed', 'queued', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "moderation_outboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_outboxes_kind_check" CHECK ("moderation_outboxes"."kind" in ('report.submit', 'decision.apply')),
	CONSTRAINT "moderation_outboxes_status_check" CHECK ("moderation_outboxes"."status" in ('pending', 'processing', 'processed', 'dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reported_type" text NOT NULL,
	"reported_id" text NOT NULL,
	"reporter" text NOT NULL,
	"categories" text[] NOT NULL,
	"details" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"local_status" text DEFAULT 'received' NOT NULL,
	"local_status_reason" text,
	"last_delivery_error" text,
	"crowd_source_report_id" text,
	"crowd_source_case_id" text,
	"crowd_source_merged" boolean,
	"content_snapshot_hash" text,
	"submitted_at" timestamp with time zone,
	"decision_id" text,
	"decision_revision" integer,
	"decision_outcome" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "reports_reported_type_check" CHECK ("reports"."reported_type" in ('agent', 'agent_review', 'skill', 'user')),
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('pending', 'reviewed', 'resolved', 'dismissed')),
	CONSTRAINT "reports_local_status_check" CHECK ("reports"."local_status" in ('received', 'queued', 'submitted', 'delivery_failed', 'closed')),
	CONSTRAINT "reports_categories_check" CHECK ("reports"."categories" <@ ARRAY['spam', 'harassment', 'hate_speech', 'explicit_content', 'impersonation', 'malicious_instructions', 'other']::text[]),
	CONSTRAINT "reports_categories_not_empty_check" CHECK (cardinality("reports"."categories") >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_enforcements_decision_revision_action_key" ON "moderation_enforcements" USING btree ("decision_id","decision_revision","action");--> statement-breakpoint
CREATE INDEX "moderation_enforcements_case_id_idx" ON "moderation_enforcements" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "moderation_events_case_id_idx" ON "moderation_events" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "moderation_events_expires_at_idx" ON "moderation_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "moderation_outboxes_claim_idx" ON "moderation_outboxes" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "moderation_outboxes_lease_idx" ON "moderation_outboxes" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "moderation_outboxes_expires_at_idx" ON "moderation_outboxes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_reporter_type_id_key" ON "reports" USING btree ("reporter","reported_type","reported_id");--> statement-breakpoint
CREATE INDEX "reports_local_status_created_at_idx" ON "reports" USING btree ("local_status","created_at");--> statement-breakpoint
CREATE INDEX "reports_crowdsource_case_id_idx" ON "reports" USING btree ("crowd_source_case_id");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter");