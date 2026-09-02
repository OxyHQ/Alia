-- oxy:deploy-phase=pre
ALTER TABLE "agent_sessions" ADD COLUMN "automation_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "automation_stage" integer;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD COLUMN "stage" integer;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_automation_run_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_automation_run_stage_key" ON "agent_sessions" USING btree ("automation_run_id","automation_stage");--> statement-breakpoint
CREATE INDEX "automation_steps_run_stage_idx" ON "automation_steps" USING btree ("run_id","stage","position");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_automation_binding_check" CHECK (("agent_sessions"."automation_run_id" is null) = ("agent_sessions"."automation_stage" is null));
