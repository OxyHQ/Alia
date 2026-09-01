-- oxy:deploy-phase=pre
--
-- Structured automations are additive in this phase. Legacy triggers and the
-- handles_autonomous_events flag remain readable until the new dispatcher has
-- run in observation mode and the post migration can remove them safely.

CREATE TABLE "automation_actor_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"objective" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"event_app_id" text,
	"event_type" text,
	"event_resource" jsonb,
	"schedule_cron" text,
	"schedule_timezone" text,
	"actor_mode" text NOT NULL,
	"fixed_agent_id" text,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_flow" jsonb DEFAULT '{"sources":[],"destinations":[]}'::jsonb NOT NULL,
	"maximum_autonomy" text NOT NULL,
	"limits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"legacy_trigger_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "automation_definitions_trigger_kind_check" CHECK ("automation_definitions"."trigger_kind" in ('manual', 'event', 'schedule')),
	CONSTRAINT "automation_definitions_actor_mode_check" CHECK ("automation_definitions"."actor_mode" in ('fixed', 'automatic')),
	CONSTRAINT "automation_definitions_autonomy_check" CHECK ("automation_definitions"."maximum_autonomy" in ('read_only', 'draft', 'execute_on_request', 'autonomous'))
);
--> statement-breakpoint
CREATE TABLE "automation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"app_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource" jsonb NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "automation_events_status_check" CHECK ("automation_events"."status" in ('received', 'matched', 'duplicate', 'processed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"requester_account_id" text NOT NULL,
	"selected_actor_type" text NOT NULL,
	"selected_agent_id" text,
	"trigger_event_id" text,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"policy_decision" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "automation_runs_status_check" CHECK ("automation_runs"."status" in ('planned', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "automation_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"position" integer NOT NULL,
	"actor_type" text NOT NULL,
	"actor_account_id" text NOT NULL,
	"resource" jsonb NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"status" text NOT NULL,
	"policy_decision" jsonb,
	"audit_event_id" text,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "automation_steps_status_check" CHECK ("automation_steps"."status" in ('planned', 'running', 'succeeded', 'failed', 'denied', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_actor_assignments_automation_agent_key" ON "automation_actor_assignments" USING btree ("automation_id","agent_id");--> statement-breakpoint
CREATE INDEX "automation_actor_assignments_priority_idx" ON "automation_actor_assignments" USING btree ("automation_id","priority","agent_id");--> statement-breakpoint
CREATE INDEX "automation_definitions_owner_idx" ON "automation_definitions" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "automation_definitions_event_idx" ON "automation_definitions" USING btree ("event_app_id","event_type");--> statement-breakpoint
CREATE INDEX "automation_definitions_schedule_idx" ON "automation_definitions" USING btree ("trigger_kind","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_definitions_legacy_trigger_key" ON "automation_definitions" USING btree ("legacy_trigger_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_events_app_event_key" ON "automation_events" USING btree ("app_id","event_id");--> statement-breakpoint
CREATE INDEX "automation_events_match_idx" ON "automation_events" USING btree ("app_id","account_id","event_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_idempotency_key" ON "automation_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "automation_runs_automation_started_idx" ON "automation_runs" USING btree ("automation_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_runs_requester_idx" ON "automation_runs" USING btree ("requester_account_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "automation_steps_run_position_key" ON "automation_steps" USING btree ("run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_steps_run_idempotency_key" ON "automation_steps" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "automation_steps_run_status_idx" ON "automation_steps" USING btree ("run_id","status");
--> statement-breakpoint
INSERT INTO "automation_definitions" (
	"id", "owner_account_id", "objective", "trigger_kind", "event_app_id", "event_type",
	"schedule_cron", "schedule_timezone", "actor_mode", "fixed_agent_id", "inputs",
	"resources", "data_flow", "maximum_autonomy", "limits", "enabled", "legacy_trigger_id",
	"created_at", "updated_at"
)
SELECT
	'legacy-trigger-' || "id",
	"oxy_user_id",
	"action_prompt",
	CASE WHEN "type" IN ('schedule', 'agent_heartbeat') THEN 'schedule' ELSE 'event' END,
	CASE WHEN "type" = 'integration_event' THEN "integration_event_service" ELSE NULL END,
	CASE
		WHEN "type" = 'integration_event' THEN "integration_event_event"
		WHEN "type" = 'webhook' THEN 'webhook'
		WHEN "type" = 'agent_heartbeat' THEN 'agent_heartbeat'
		ELSE NULL
	END,
	"schedule_cron",
	"schedule_timezone",
	CASE WHEN "action_agent_id" IS NULL THEN 'automatic' ELSE 'fixed' END,
	"action_agent_id",
	jsonb_build_object(
		'legacyScheduleType', "schedule_type",
		'legacyScheduleTime', "schedule_time",
		'legacyScheduleDays', COALESCE(to_jsonb("schedule_days"), '[]'::jsonb),
		'legacyScheduleIntervalMinutes', "schedule_interval_minutes",
		'useTools', "action_use_tools",
		'notify', "action_notify",
		'channelId', "action_channel_id"
	),
	'[]'::jsonb,
	'{"sources":[],"destinations":[]}'::jsonb,
	'autonomous',
	'[]'::jsonb,
	"enabled",
	"id",
	"created_at",
	"updated_at"
FROM "triggers"
ON CONFLICT ("legacy_trigger_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "automation_definitions" (
	"id", "owner_account_id", "objective", "trigger_kind", "event_app_id", "event_type",
	"actor_mode", "fixed_agent_id", "inputs", "resources", "data_flow",
	"maximum_autonomy", "limits", "enabled", "created_at", "updated_at"
)
SELECT
	'legacy-autonomy-' || "id",
	"author_oxy_user_id",
	'Handle delegated Oxy app events',
	'event',
	NULL,
	'*',
	'fixed',
	"id",
	'{"migration":"handles_autonomous_events"}'::jsonb,
	'[]'::jsonb,
	'{"sources":[],"destinations":[]}'::jsonb,
	'autonomous',
	'[]'::jsonb,
	true,
	"created_at",
	"updated_at"
FROM "agents"
WHERE "handles_autonomous_events" = true
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "automation_actor_assignments" (
	"id", "automation_id", "agent_id", "priority", "created_at"
)
SELECT
	'legacy-assignment-' || "id",
	"id",
	"fixed_agent_id",
	0,
	"created_at"
FROM "automation_definitions"
WHERE "fixed_agent_id" IS NOT NULL
ON CONFLICT ("automation_id", "agent_id") DO NOTHING;
