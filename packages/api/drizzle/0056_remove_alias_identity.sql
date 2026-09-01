-- oxy:deploy-phase=post
--
-- Kaana routing-profile vocabulary, part two of two. 0055 kept the previous
-- image's names live through compatibility views and mirrored columns. The new
-- image is now stable, so this removes that temporary surface and leaves only
-- routing-profile identity in the active database.

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
DROP INDEX "cost_entries_alias_model_timestamp_idx";--> statement-breakpoint
DROP INDEX "cost_entries_user_alias_model_idx";--> statement-breakpoint
DROP INDEX "voice_call_usage_alia_model_start_time_idx";--> statement-breakpoint

ALTER TABLE "fallback_events" DROP COLUMN "alias_model";--> statement-breakpoint
ALTER TABLE "chat_analytics" DROP COLUMN "alia_model_id";--> statement-breakpoint
ALTER TABLE "cost_entries" DROP COLUMN "alias_model_id";--> statement-breakpoint
ALTER TABLE "voice_call_usage" DROP COLUMN "alia_model_id";--> statement-breakpoint

ALTER TABLE "routing_profile_provider_mappings"
  RENAME CONSTRAINT "alia_model_provider_mappings_provider_check"
  TO "routing_profile_provider_mappings_provider_check";--> statement-breakpoint
ALTER TABLE "routing_profile_provider_mappings"
  RENAME CONSTRAINT "alia_model_provider_mappings_priority_range_check"
  TO "routing_profile_provider_mappings_priority_range_check";--> statement-breakpoint
ALTER TABLE "routing_profile_provider_mappings"
  RENAME CONSTRAINT "alia_model_provider_mappings_quality_score_range_check"
  TO "routing_profile_provider_mappings_quality_score_range_check";--> statement-breakpoint
ALTER TABLE "routing_profile_provider_mappings"
  RENAME CONSTRAINT "alia_model_provider_mappings_alia_model_id_fk"
  TO "routing_profile_provider_mappings_routing_profile_id_fk";--> statement-breakpoint
ALTER TABLE "routing_profile_provider_mappings"
  RENAME CONSTRAINT "alia_model_provider_mappings_model_config_id_fk"
  TO "routing_profile_provider_mappings_model_config_id_fk";--> statement-breakpoint

ALTER TABLE "routing_profiles"
  RENAME CONSTRAINT "alia_models_tier_check"
  TO "routing_profiles_tier_check";--> statement-breakpoint
ALTER TABLE "routing_profiles"
  RENAME CONSTRAINT "alia_models_credit_multiplier_range_check"
  TO "routing_profiles_credit_multiplier_range_check";--> statement-breakpoint

ALTER INDEX "alia_model_provider_mappings_model_config_key"
  RENAME TO "routing_profile_provider_mappings_model_config_key";--> statement-breakpoint
ALTER INDEX "alia_model_provider_mappings_alia_model_priority_idx"
  RENAME TO "routing_profile_provider_mappings_routing_profile_priority_idx";--> statement-breakpoint
ALTER INDEX "alia_models_alias_model_id_key"
  RENAME TO "routing_profiles_routing_profile_id_key";--> statement-breakpoint
ALTER INDEX "alia_models_tier_active_idx"
  RENAME TO "routing_profiles_tier_active_idx";--> statement-breakpoint
ALTER INDEX "alia_models_active_deprecated_idx"
  RENAME TO "routing_profiles_active_deprecated_idx";
