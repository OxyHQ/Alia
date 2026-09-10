-- oxy:deploy-phase=pre
ALTER TABLE "agent_sessions" ADD COLUMN "chat_lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "agent_sessions"
SET "chat_lease_expires_at" = COALESCE("stats_last_activity_at", "created_at") + interval '2 minutes'
WHERE "status" = 'running'
  AND "conversation_id" IS NOT NULL
  AND "chat_lease_expires_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_sessions_chat_lease_expiry_idx" ON "agent_sessions" USING btree ("chat_lease_expires_at") WHERE "agent_sessions"."chat_lease_expires_at" is not null;
