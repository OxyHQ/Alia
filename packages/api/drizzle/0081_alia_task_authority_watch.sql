-- oxy:deploy-phase=pre
--
-- Alia acts for the owner of a task she is responsible for. Additive only, so
-- the image still serving this deploy keeps working:
--  - `alia_task_authorizations`: opaque Oxy execution-authorization ids for the
--    standing read authority and declared connected actions of an Alia task.
--  - `automation_watch_states`: what a watch task's cheap tick saw last and its
--    failure streak.
--  - `automation_runs.credit_reservation` / `lease_expires_at`: an Alia run's
--    hold and worker lease, so a run whose worker vanished is failed and
--    refunded by the reaper. The old image never writes them (NULL).
CREATE TABLE "alia_task_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"automation_action_id" text,
	"resource_app_id" text NOT NULL,
	"effective_account_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"tool" text NOT NULL,
	"oxy_authorization_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_watch_states" (
	"automation_id" text PRIMARY KEY NOT NULL,
	"last_hash" text,
	"last_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched" boolean DEFAULT false NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "automation_watch_states_failures_check" CHECK ("automation_watch_states"."consecutive_failures" >= 0),
	CONSTRAINT "automation_watch_states_items_check" CHECK (jsonb_typeof("automation_watch_states"."last_items") = 'array')
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "credit_reservation" jsonb;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alia_task_authorizations" ADD CONSTRAINT "alia_task_authorizations_automation_id_automation_definitions_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alia_task_authorizations" ADD CONSTRAINT "alia_task_authorizations_automation_action_id_automation_actions_id_fk" FOREIGN KEY ("automation_action_id") REFERENCES "public"."automation_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_watch_states" ADD CONSTRAINT "automation_watch_states_automation_id_automation_definitions_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alia_task_authorizations_exact_tool_key" ON "alia_task_authorizations" USING btree ("automation_id","resource_app_id","effective_account_id","resource_type","resource_id","tool");--> statement-breakpoint
CREATE UNIQUE INDEX "alia_task_authorizations_oxy_key" ON "alia_task_authorizations" USING btree ("oxy_authorization_id");--> statement-breakpoint
CREATE INDEX "alia_task_authorizations_live_idx" ON "alia_task_authorizations" USING btree ("automation_id","expires_at","revoked_at");--> statement-breakpoint
CREATE INDEX "automation_runs_alia_open_idx" ON "automation_runs" USING btree ("status","lease_expires_at","started_at") WHERE "automation_runs"."selected_actor_type" = 'alia' and "automation_runs"."status" in ('planned', 'running');