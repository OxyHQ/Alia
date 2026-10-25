-- oxy:deploy-phase=pre
-- Additive durable task references; no legacy bearer is promoted by schema migration.
ALTER TABLE "agent_sessions" ADD COLUMN "oxy_task_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "oxy_task_retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_users" ADD COLUMN "oxy_task_id" text;--> statement-breakpoint
ALTER TABLE "bot_users" ADD COLUMN "oxy_task_state" text DEFAULT 'reauth_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "oxy_task_id" text;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "oxy_task_state" text DEFAULT 'reauth_required' NOT NULL;