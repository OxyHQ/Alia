-- oxy:deploy-phase=pre
CREATE TABLE "agent_work_authorities" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"oxy_task_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"oxy_task_id" text NOT NULL,
	"kind" text NOT NULL,
	"objective" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"root_id" text NOT NULL,
	"source_session_id" text,
	"session_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_work_status_check" CHECK ("agent_work_items"."status" in ('pending', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_work_kind_check" CHECK ("agent_work_items"."kind" in ('heartbeat', 'follow_up'))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "work_item_id" text;--> statement-breakpoint
ALTER TABLE "agent_work_authorities" ADD CONSTRAINT "agent_work_authorities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_work_authority_task_key" ON "agent_work_authorities" USING btree ("oxy_task_id");--> statement-breakpoint
CREATE INDEX "agent_work_due_idx" ON "agent_work_items" USING btree ("due_at") WHERE "agent_work_items"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "agent_work_agent_status_idx" ON "agent_work_items" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_work_root_idx" ON "agent_work_items" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "agent_work_authority_idx" ON "agent_work_items" USING btree ("oxy_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_work_session_key" ON "agent_work_items" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_work_heartbeat_key" ON "agent_work_items" USING btree ("agent_id") WHERE "agent_work_items"."kind" = 'heartbeat' and "agent_work_items"."status" in ('pending', 'running');
--> statement-breakpoint
ALTER TABLE "automation_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_events" ADD COLUMN "retry_after" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "agent_work_revocations" (
	"oxy_task_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
