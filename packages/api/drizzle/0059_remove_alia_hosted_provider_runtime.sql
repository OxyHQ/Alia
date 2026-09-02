-- oxy:deploy-phase=post
-- Kaana owns hosted inference credentials and provider runtime state after cutover.
-- Historical migrations retain these tables so rolling/pre-cutover upgrades remain safe;
-- this post-cutover migration removes them only after rollback to Alia is no longer allowed.
DROP TABLE "provider_keys" CASCADE;--> statement-breakpoint
DROP TABLE "api_usage" CASCADE;--> statement-breakpoint
DROP TABLE "fallback_events" CASCADE;--> statement-breakpoint
DROP TABLE "provider_health" CASCADE;
