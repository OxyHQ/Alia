-- oxy:deploy-phase=pre
ALTER TABLE "fallback_events" ADD COLUMN "fallback_policy" text;--> statement-breakpoint
ALTER TABLE "fallback_events" ADD COLUMN "routing_policy_version" integer;