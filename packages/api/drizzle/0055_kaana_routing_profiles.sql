-- oxy:deploy-phase=pre
--
-- Kaana routing-profile vocabulary, part one of two: expose the new names while
-- the previous image is still serving.
--
-- The two catalogue tables can be renamed without copying data. Read/write
-- compatibility views keep the previous image's SELECT/INSERT/UPDATE/DELETE
-- surface available during the rollout; the new image uses the real tables.
-- The deploy seeder runs only after the new image is live, so no previous-image
-- ON CONFLICT statement is sent through these views (Postgres does not support
-- ON CONFLICT on an automatically updatable view).
--
-- Columns on shared telemetry tables cannot use that technique because the
-- table name is unchanged. They therefore live side by side for the rollout and
-- a trigger mirrors whichever spelling the active image writes. 0056 removes
-- every temporary view, trigger and old column after the new image is stable.

ALTER TABLE "alia_model_provider_mappings" RENAME TO "routing_profile_provider_mappings";--> statement-breakpoint
ALTER TABLE "alia_models" RENAME TO "routing_profiles";--> statement-breakpoint
ALTER TABLE "routing_profile_provider_mappings" RENAME COLUMN "alia_model_id" TO "routing_profile_id";--> statement-breakpoint
ALTER TABLE "routing_profiles" RENAME COLUMN "alias_model_id" TO "routing_profile_id";--> statement-breakpoint

CREATE VIEW "alia_models" AS
SELECT
  "id",
  "routing_profile_id" AS "alias_model_id",
  "display_name",
  "tier",
  "description",
  "features",
  "credit_multiplier",
  "is_free_tier",
  "aggregated_capabilities_vision",
  "aggregated_capabilities_audio",
  "aggregated_capabilities_code_execution",
  "aggregated_capabilities_web_search",
  "aggregated_capabilities_thinking",
  "is_active",
  "is_deprecated",
  "is_legacy",
  "deprecation_date",
  "replacement_model_id",
  "total_requests",
  "total_tokens",
  "average_latency_ms",
  "notes",
  "created_at",
  "updated_at"
FROM "routing_profiles";--> statement-breakpoint

CREATE VIEW "alia_model_provider_mappings" AS
SELECT
  "id",
  "routing_profile_id" AS "alia_model_id",
  "model_config_id",
  "provider",
  "model_id",
  "priority",
  "quality_score",
  "is_active"
FROM "routing_profile_provider_mappings";--> statement-breakpoint

ALTER TABLE "fallback_events" ADD COLUMN "routing_profile" text;--> statement-breakpoint
UPDATE "fallback_events" SET "routing_profile" = "alias_model";--> statement-breakpoint
ALTER TABLE "fallback_events" ALTER COLUMN "routing_profile" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "chat_analytics" ADD COLUMN "routing_profile_id" text;--> statement-breakpoint
UPDATE "chat_analytics" SET "routing_profile_id" = "alia_model_id";--> statement-breakpoint

ALTER TABLE "cost_entries" ADD COLUMN "routing_profile_id" text;--> statement-breakpoint
UPDATE "cost_entries" SET "routing_profile_id" = "alias_model_id";--> statement-breakpoint
ALTER TABLE "cost_entries" ALTER COLUMN "routing_profile_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "voice_call_usage" ADD COLUMN "routing_profile_id" text;--> statement-breakpoint
UPDATE "voice_call_usage" SET "routing_profile_id" = "alia_model_id";--> statement-breakpoint
ALTER TABLE "voice_call_usage" ALTER COLUMN "routing_profile_id" SET NOT NULL;--> statement-breakpoint

CREATE FUNCTION "sync_fallback_event_routing_profile"() RETURNS trigger AS $$
BEGIN
  IF NEW.routing_profile IS NULL THEN
    NEW.routing_profile := NEW.alias_model;
  ELSIF NEW.alias_model IS NULL THEN
    NEW.alias_model := NEW.routing_profile;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.routing_profile IS DISTINCT FROM OLD.routing_profile
    AND NEW.alias_model IS NOT DISTINCT FROM OLD.alias_model THEN
    NEW.alias_model := NEW.routing_profile;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.alias_model IS DISTINCT FROM OLD.alias_model
    AND NEW.routing_profile IS NOT DISTINCT FROM OLD.routing_profile THEN
    NEW.routing_profile := NEW.alias_model;
  ELSIF NEW.routing_profile IS DISTINCT FROM NEW.alias_model THEN
    RAISE EXCEPTION 'routing profile columns disagree';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sync_fallback_event_routing_profile"
BEFORE INSERT OR UPDATE ON "fallback_events"
FOR EACH ROW EXECUTE FUNCTION "sync_fallback_event_routing_profile"();--> statement-breakpoint

CREATE FUNCTION "sync_chat_analytics_routing_profile"() RETURNS trigger AS $$
BEGIN
  IF NEW.routing_profile_id IS NULL THEN
    NEW.routing_profile_id := NEW.alia_model_id;
  ELSIF NEW.alia_model_id IS NULL THEN
    NEW.alia_model_id := NEW.routing_profile_id;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.routing_profile_id IS DISTINCT FROM OLD.routing_profile_id
    AND NEW.alia_model_id IS NOT DISTINCT FROM OLD.alia_model_id THEN
    NEW.alia_model_id := NEW.routing_profile_id;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.alia_model_id IS DISTINCT FROM OLD.alia_model_id
    AND NEW.routing_profile_id IS NOT DISTINCT FROM OLD.routing_profile_id THEN
    NEW.routing_profile_id := NEW.alia_model_id;
  ELSIF NEW.routing_profile_id IS DISTINCT FROM NEW.alia_model_id THEN
    RAISE EXCEPTION 'routing profile columns disagree';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sync_chat_analytics_routing_profile"
BEFORE INSERT OR UPDATE ON "chat_analytics"
FOR EACH ROW EXECUTE FUNCTION "sync_chat_analytics_routing_profile"();--> statement-breakpoint

CREATE FUNCTION "sync_cost_entry_routing_profile"() RETURNS trigger AS $$
BEGIN
  IF NEW.routing_profile_id IS NULL THEN
    NEW.routing_profile_id := NEW.alias_model_id;
  ELSIF NEW.alias_model_id IS NULL THEN
    NEW.alias_model_id := NEW.routing_profile_id;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.routing_profile_id IS DISTINCT FROM OLD.routing_profile_id
    AND NEW.alias_model_id IS NOT DISTINCT FROM OLD.alias_model_id THEN
    NEW.alias_model_id := NEW.routing_profile_id;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.alias_model_id IS DISTINCT FROM OLD.alias_model_id
    AND NEW.routing_profile_id IS NOT DISTINCT FROM OLD.routing_profile_id THEN
    NEW.routing_profile_id := NEW.alias_model_id;
  ELSIF NEW.routing_profile_id IS DISTINCT FROM NEW.alias_model_id THEN
    RAISE EXCEPTION 'routing profile columns disagree';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sync_cost_entry_routing_profile"
BEFORE INSERT OR UPDATE ON "cost_entries"
FOR EACH ROW EXECUTE FUNCTION "sync_cost_entry_routing_profile"();--> statement-breakpoint

CREATE FUNCTION "sync_voice_call_routing_profile"() RETURNS trigger AS $$
BEGIN
  IF NEW.routing_profile_id IS NULL THEN
    NEW.routing_profile_id := NEW.alia_model_id;
  ELSIF NEW.alia_model_id IS NULL THEN
    NEW.alia_model_id := NEW.routing_profile_id;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.routing_profile_id IS DISTINCT FROM OLD.routing_profile_id
    AND NEW.alia_model_id IS NOT DISTINCT FROM OLD.alia_model_id THEN
    NEW.alia_model_id := NEW.routing_profile_id;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.alia_model_id IS DISTINCT FROM OLD.alia_model_id
    AND NEW.routing_profile_id IS NOT DISTINCT FROM OLD.routing_profile_id THEN
    NEW.routing_profile_id := NEW.alia_model_id;
  ELSIF NEW.routing_profile_id IS DISTINCT FROM NEW.alia_model_id THEN
    RAISE EXCEPTION 'routing profile columns disagree';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sync_voice_call_routing_profile"
BEFORE INSERT OR UPDATE ON "voice_call_usage"
FOR EACH ROW EXECUTE FUNCTION "sync_voice_call_routing_profile"();--> statement-breakpoint

CREATE INDEX "fallback_events_routing_profile_timestamp_idx" ON "fallback_events" USING btree ("routing_profile","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cost_entries_routing_profile_timestamp_idx" ON "cost_entries" USING btree ("routing_profile_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cost_entries_user_routing_profile_idx" ON "cost_entries" USING btree ("user_id","routing_profile_id");--> statement-breakpoint
CREATE INDEX "voice_call_usage_routing_profile_start_time_idx" ON "voice_call_usage" USING btree ("routing_profile_id","start_time" DESC NULLS LAST);--> statement-breakpoint

ALTER TABLE "agents" ALTER COLUMN "allowed_models" SET DEFAULT '{"kaana-v1","kaana-v1-pro"}';
