-- oxy:deploy-phase=pre
--
-- Alia uses real models (ADR 0012), expand half. Additive and loosening only,
-- so the image still serving this deploy keeps working:
--  - `model_id` on agents and agent threads, NULL = the default model. Old
--    opaque routing-profile UUIDs are NOT carried over: they name no model.
--  - the CHECKs pinning `routing_profile_id` to reviewed UUIDs go, and the
--    NOT NULLs the new image no longer writes are relaxed.
-- 0079 (post) drops the retired columns once the new image is serving.
ALTER TABLE "agents" DROP CONSTRAINT "agents_routing_profile_id_check";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT "agent_threads_routing_profile_id_check";--> statement-breakpoint
ALTER TABLE "agent_threads" ALTER COLUMN "routing_profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_analytics" ALTER COLUMN "requested_model_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "model_id" text;