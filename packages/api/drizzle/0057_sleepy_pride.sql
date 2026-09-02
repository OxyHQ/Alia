-- oxy:deploy-phase=pre
CREATE TABLE "automation_action_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_action_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"actor_account_id" text NOT NULL,
	"oxy_authorization_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"position" integer NOT NULL,
	"resource_app_id" text NOT NULL,
	"effective_account_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "automation_actions_input_check" CHECK (jsonb_typeof("automation_actions"."input") = 'object'),
	CONSTRAINT "automation_actions_limits_check" CHECK (jsonb_typeof("automation_actions"."limits") = 'array'
        and not jsonb_path_exists("automation_actions"."limits", '$[*] ? (@.type() != "object" || !exists(@.key) || @.key.type() != "string" || !exists(@.value) || (@.value.type() != "number" && @.value.type() != "boolean"))')
        and not jsonb_path_exists("automation_actions"."limits", '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "key" && @.key != "value")'))
);
--> statement-breakpoint
ALTER TABLE "automation_runs" DROP CONSTRAINT "automation_runs_status_check";--> statement-breakpoint
ALTER TABLE "automation_steps" DROP CONSTRAINT "automation_steps_status_check";--> statement-breakpoint
ALTER TABLE "automation_definitions" ADD COLUMN "execution_mode" text DEFAULT 'observe' NOT NULL;--> statement-breakpoint
-- Legacy trigger rows continue through their existing scheduler. Structured
-- definitions created before exact action authority shipped remain observe-only.
UPDATE "automation_definitions" SET "execution_mode" = 'execute' WHERE "legacy_trigger_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD COLUMN "automation_action_id" text;--> statement-breakpoint
ALTER TABLE "automation_action_authorizations" ADD CONSTRAINT "automation_action_authorizations_automation_action_id_automation_actions_id_fk" FOREIGN KEY ("automation_action_id") REFERENCES "public"."automation_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_automation_id_automation_definitions_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_action_authorizations_action_agent_key" ON "automation_action_authorizations" USING btree ("automation_action_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_action_authorizations_oxy_key" ON "automation_action_authorizations" USING btree ("oxy_authorization_id");--> statement-breakpoint
CREATE INDEX "automation_action_authorizations_agent_live_idx" ON "automation_action_authorizations" USING btree ("agent_id","expires_at","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_actions_automation_position_key" ON "automation_actions" USING btree ("automation_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_actions_exact_tool_key" ON "automation_actions" USING btree ("automation_id","resource_app_id","effective_account_id","resource_type","resource_id","tool");--> statement-breakpoint
CREATE INDEX "automation_actions_resource_idx" ON "automation_actions" USING btree ("resource_app_id","effective_account_id","resource_type","resource_id");--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_automation_action_id_automation_actions_id_fk" FOREIGN KEY ("automation_action_id") REFERENCES "public"."automation_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_definitions" ADD CONSTRAINT "automation_definitions_execution_mode_check" CHECK ("automation_definitions"."execution_mode" in ('observe', 'execute'));--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_status_check" CHECK ("automation_runs"."status" in ('planned', 'running', 'observed', 'succeeded', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_status_check" CHECK ("automation_steps"."status" in ('planned', 'running', 'observed', 'succeeded', 'failed', 'denied', 'cancelled'));
