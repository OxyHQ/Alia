-- oxy:deploy-phase=pre
ALTER TABLE "automation_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_events" ADD COLUMN "retry_after" timestamp with time zone;
