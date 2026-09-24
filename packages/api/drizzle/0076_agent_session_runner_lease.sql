-- oxy:deploy-phase=pre
ALTER TABLE "agent_sessions" ADD COLUMN "runner_lease_owner" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "runner_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "runner_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_sessions_runner_lease_expiry_idx" ON "agent_sessions" USING btree ("runner_lease_expires_at") WHERE "agent_sessions"."status" = 'running' and "agent_sessions"."runner_lease_expires_at" is not null;