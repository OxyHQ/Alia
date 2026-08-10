-- oxy:deploy-phase=pre
--
-- Additive only: four new tables for triggers and workflows. Nothing existing is
-- touched. The serving image writes all four collections in Mongo.
--
-- `triggers` looks like it is missing a constraint and is not. `type` selects
-- which configuration group applies, but the obvious discriminant CHECK
-- (`type = 'schedule'` <=> `schedule_type is not null`) would be WRONG:
-- `agent_heartbeat` triggers ALSO carry a schedule, and `lib/trigger-engine.ts`
-- both schedules `type IN ('schedule','agent_heartbeat')` and creates heartbeat
-- triggers itself. Mongoose enforced no cross-field rule either, so production
-- may hold any combination. The correct constraint is `schedule present =>
-- type IN ('schedule','agent_heartbeat')`, and it is a backfill audit item
-- rather than something to guess at here.
--
-- `triggers.webhook_token` is PLAINTEXT and indexed because it is the public
-- URL's path segment and the key `trigger-engine.ts` finds a trigger by. The
-- same rule as `bots.webhook_secret`: an encrypted column cannot be matched by
-- equality, since the codec's IV is random.
--
CREATE TABLE "trigger_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"status" text NOT NULL,
	"trigger_type" text NOT NULL,
	"input_event" text,
	"input_payload" jsonb,
	"input_source" text,
	"result" text,
	"tool_calls" jsonb,
	"tokens_prompt" integer,
	"tokens_completion" integer,
	"tokens_total" integer,
	"duration_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "trigger_executions_status_check" CHECK ("trigger_executions"."status" in ('running', 'success', 'failed')),
	CONSTRAINT "trigger_executions_trigger_type_check" CHECK ("trigger_executions"."trigger_type" in ('schedule', 'webhook', 'integration_event', 'agent_heartbeat', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"action_prompt" text NOT NULL,
	"action_agent_id" text,
	"action_role_id" text,
	"action_use_tools" boolean DEFAULT false NOT NULL,
	"action_notify" boolean DEFAULT false NOT NULL,
	"action_channel_id" text,
	"schedule_type" text,
	"schedule_cron" text,
	"schedule_time" text,
	"schedule_days" text[],
	"schedule_interval_minutes" integer,
	"schedule_timezone" text,
	"webhook_token" text,
	"webhook_secret" text,
	"webhook_allowed_ips" text[],
	"integration_event_integration_id" text,
	"integration_event_service" text,
	"integration_event_event" text,
	"integration_event_filters" jsonb,
	"last_triggered_at" timestamp with time zone,
	"next_trigger_at" timestamp with time zone,
	"trigger_count" integer DEFAULT 0 NOT NULL,
	"last_status" text,
	"last_result" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "triggers_type_check" CHECK ("triggers"."type" in ('schedule', 'webhook', 'integration_event', 'agent_heartbeat')),
	CONSTRAINT "triggers_schedule_type_check" CHECK ("triggers"."schedule_type" in ('cron', 'daily', 'interval')),
	CONSTRAINT "triggers_last_status_check" CHECK ("triggers"."last_status" in ('success', 'failed', 'running'))
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_output" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workflow_executions_status_check" CHECK ("workflow_executions"."status" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"nodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "trigger_executions_trigger_started_idx" ON "trigger_executions" USING btree ("trigger_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_executions_oxy_user_id_idx" ON "trigger_executions" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "trigger_executions_started_at_idx" ON "trigger_executions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "triggers_oxy_user_id_idx" ON "triggers" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "triggers_oxy_user_type_idx" ON "triggers" USING btree ("oxy_user_id","type");--> statement-breakpoint
CREATE INDEX "triggers_type_enabled_idx" ON "triggers" USING btree ("type","enabled");--> statement-breakpoint
CREATE INDEX "triggers_webhook_token_idx" ON "triggers" USING btree ("webhook_token") WHERE "triggers"."webhook_token" is not null;--> statement-breakpoint
CREATE INDEX "triggers_integration_event_idx" ON "triggers" USING btree ("integration_event_service","integration_event_event") WHERE "triggers"."integration_event_service" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_executions_execution_id_key" ON "workflow_executions" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "workflow_executions_workflow_id_idx" ON "workflow_executions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_executions_oxy_user_id_idx" ON "workflow_executions" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_workflow_id_key" ON "workflows" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflows_oxy_user_id_idx" ON "workflows" USING btree ("oxy_user_id");