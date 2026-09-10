-- oxy:deploy-phase=pre
-- Durable agent runtime. Additive so the previous image remains valid while
-- threads and historical conversations are linked by the new runtime.
CREATE TABLE "agent_approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"risk_level" text NOT NULL,
	"action_hash" text NOT NULL,
	"resource" text,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_oxy_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_approval_status_check" CHECK ("agent_approval_requests"."status" in ('pending', 'approved', 'denied', 'expired', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "agent_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"objective" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"plan_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification_plan" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"max_turns" integer DEFAULT 50 NOT NULL,
	"max_tokens" integer DEFAULT 100000 NOT NULL,
	"max_duration_seconds" integer DEFAULT 3600 NOT NULL,
	"max_credits" integer,
	"turns_used" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"no_progress_turns" integer DEFAULT 0 NOT NULL,
	"price_credits" integer DEFAULT 0 NOT NULL,
	"reservation_id" text,
	"idempotency_key" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_goals_status_check" CHECK ("agent_goals"."status" in ('active', 'paused', 'blocked', 'candidate', 'completed', 'cancelled')),
	CONSTRAINT "agent_goals_budget_check" CHECK ("agent_goals"."max_turns" > 0 and "agent_goals"."max_tokens" > 0 and "agent_goals"."max_duration_seconds" > 0),
	CONSTRAINT "agent_goals_criteria_check" CHECK (jsonb_array_length("agent_goals"."criteria") between 3 and 5)
);
--> statement-breakpoint
CREATE TABLE "agent_memory_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"byte_length" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory_journal" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"actor_oxy_account_id" text NOT NULL,
	"origin" text NOT NULL,
	"before_hash" text,
	"after_hash" text NOT NULL,
	"before_content" text,
	"after_content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_team_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"responder_policy" text DEFAULT 'coordinator' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_team_members_role_check" CHECK ("agent_team_members"."role" in ('coordinator', 'member'))
);
--> statement-breakpoint
CREATE TABLE "agent_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text DEFAULT 'New thread' NOT NULL,
	"folder_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"routing_profile_id" text NOT NULL,
	"reasoning_effort" text,
	"approval_mode" text DEFAULT 'ask' NOT NULL,
	"execution_target" text DEFAULT 'sandbox' NOT NULL,
	"cowork_device_id" text,
	"opened_by_agent_id" text,
	"opened_by_delegation_id" text,
	"last_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_threads_status_check" CHECK ("agent_threads"."status" in ('open', 'closed')),
	CONSTRAINT "agent_threads_approval_mode_check" CHECK ("agent_threads"."approval_mode" in ('ask', 'supervised_auto')),
	CONSTRAINT "agent_threads_execution_target_check" CHECK ("agent_threads"."execution_target" in ('sandbox', 'cowork')),
	CONSTRAINT "agent_threads_cowork_target_check" CHECK (("agent_threads"."execution_target" = 'cowork') = ("agent_threads"."cowork_device_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "cowork_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"version" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "cowork_devices_status_check" CHECK ("cowork_devices"."status" in ('online', 'offline', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "max_concurrent_threads" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "goal_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "agent_thread_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_approval_turn_action_key" ON "agent_approval_requests" USING btree ("turn_id","action_hash");--> statement-breakpoint
CREATE INDEX "agent_approval_owner_status_expiry_idx" ON "agent_approval_requests" USING btree ("oxy_user_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_goals_owner_idempotency_key" ON "agent_goals" USING btree ("oxy_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_goals_thread_status_created_idx" ON "agent_goals" USING btree ("thread_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_agent_path_key" ON "agent_memory_documents" USING btree ("agent_id","path");--> statement-breakpoint
CREATE INDEX "agent_memory_owner_agent_updated_idx" ON "agent_memory_documents" USING btree ("oxy_user_id","agent_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_memory_journal_document_created_idx" ON "agent_memory_journal" USING btree ("document_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_team_channels_team_name_key" ON "agent_team_channels" USING btree ("team_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_team_members_team_agent_key" ON "agent_team_members" USING btree ("team_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_team_members_team_position_idx" ON "agent_team_members" USING btree ("team_id","position");--> statement-breakpoint
CREATE INDEX "agent_teams_owner_updated_idx" ON "agent_teams" USING btree ("oxy_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_threads_owner_agent_updated_idx" ON "agent_threads" USING btree ("oxy_user_id","agent_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_threads_agent_status_created_idx" ON "agent_threads" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "cowork_devices_owner_status_idx" ON "cowork_devices" USING btree ("oxy_user_id","status");--> statement-breakpoint
CREATE INDEX "conversations_agent_thread_updated_at_idx" ON "conversations" USING btree ("agent_thread_id","updated_at" DESC NULLS LAST);
--> statement-breakpoint
-- One deterministic legacy thread per existing person/agent pair. Rows whose
-- agent has not been reconciled to an exact Oxy routing profile fail closed and
-- remain on the legacy read path until that reconciliation happens.
INSERT INTO "agent_threads" (
  "id", "oxy_user_id", "agent_id", "title", "routing_profile_id", "created_at", "updated_at"
)
SELECT
  'legacy_' || md5(c."oxy_user_id" || ':' || c."agent_id"),
  c."oxy_user_id",
  c."agent_id",
  COALESCE((array_agg(c."title" ORDER BY c."updated_at" DESC))[1], 'Agent thread'),
  a."routing_profile_id",
  min(c."created_at"),
  max(c."updated_at")
FROM "conversations" c
JOIN "agents" a ON a."id" = c."agent_id"
WHERE c."agent_id" IS NOT NULL AND a."routing_profile_id" IS NOT NULL
GROUP BY c."oxy_user_id", c."agent_id", a."routing_profile_id"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "conversations" c
SET "agent_thread_id" = 'legacy_' || md5(c."oxy_user_id" || ':' || c."agent_id")
WHERE c."agent_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "agent_threads" t
    WHERE t."id" = 'legacy_' || md5(c."oxy_user_id" || ':' || c."agent_id")
  );
