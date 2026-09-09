-- oxy:deploy-phase=post
--
-- The compatibility window is closed. The current application has used only
-- routing-profile columns since migration 0059, so remove the previous-image
-- views, mirroring triggers and duplicate telemetry columns outright.
DROP VIEW "alia_model_provider_mappings";--> statement-breakpoint
DROP VIEW "alia_models";--> statement-breakpoint

DROP TRIGGER "sync_fallback_event_routing_profile" ON "fallback_events";--> statement-breakpoint
DROP FUNCTION "sync_fallback_event_routing_profile"();--> statement-breakpoint
DROP TRIGGER "sync_chat_analytics_routing_profile" ON "chat_analytics";--> statement-breakpoint
DROP FUNCTION "sync_chat_analytics_routing_profile"();--> statement-breakpoint
DROP TRIGGER "sync_cost_entry_routing_profile" ON "cost_entries";--> statement-breakpoint
DROP FUNCTION "sync_cost_entry_routing_profile"();--> statement-breakpoint
DROP TRIGGER "sync_voice_call_routing_profile" ON "voice_call_usage";--> statement-breakpoint
DROP FUNCTION "sync_voice_call_routing_profile"();--> statement-breakpoint

DROP INDEX "fallback_events_alias_timestamp_idx";--> statement-breakpoint
ALTER TABLE "fallback_events" DROP COLUMN "alias_model";--> statement-breakpoint
ALTER TABLE "chat_analytics" DROP COLUMN "alia_model_id";--> statement-breakpoint
ALTER TABLE "cost_entries" DROP COLUMN "alias_model_id";--> statement-breakpoint
ALTER TABLE "voice_call_usage" DROP COLUMN "alia_model_id";
