-- oxy:deploy-phase=pre
--
-- Phase 3 (proactive and memory). Additive only: the image still serving this
-- deploy never reads the two new tables, and the per-person memory index sits
-- beside the old per-agent one until 0085 (post) drops it.
CREATE TABLE "email_alert_preferences" (
	"oxy_user_id" text NOT NULL,
	"agent_id" text,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "email_alert_preferences_user_agent_key" UNIQUE NULLS NOT DISTINCT("oxy_user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "email_outreach_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_account_id" text NOT NULL,
	"message_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"agent_id" text,
	"verdict" text NOT NULL,
	"reason" text,
	"posted_message_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "email_outreach_decisions_verdict_check" CHECK ("email_outreach_decisions"."verdict" in ('pending', 'important', 'not_important', 'skipped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "email_alert_preferences" ADD CONSTRAINT "email_alert_preferences_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outreach_decisions" ADD CONSTRAINT "email_outreach_decisions_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_outreach_decisions_mailbox_message_key" ON "email_outreach_decisions" USING btree ("mailbox_account_id","message_id");--> statement-breakpoint
CREATE INDEX "email_outreach_decisions_created_idx" ON "email_outreach_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_agent_user_path_key" ON "agent_memory_documents" USING btree ("agent_id","oxy_user_id","path");